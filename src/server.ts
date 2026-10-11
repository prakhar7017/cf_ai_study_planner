import { createWorkersAI } from "workers-ai-provider";
import { callable, routeAgentRequest, type Schedule } from "agents";
import { getSchedulePrompt, scheduleSchema } from "agents/schedule";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  convertToModelMessages,
  pruneMessages,
  stepCountIs,
  streamText,
  tool
} from "ai";
import { z } from "zod";

/* ------------------------------------------------------------------ */
/* State (memory)                                                      */
/* Stored in the agent's own Durable Object storage, so it survives    */
/* page refreshes, restarts and redeploys. It is also synced live to   */
/* every connected browser, which is how the UI sidebar stays updated. */
/* ------------------------------------------------------------------ */

export type Task = {
  id: string;
  title: string;
  subject: string;
  dueDate: string | null; // ISO date, e.g. "2026-11-02"
  done: boolean;
  createdAt: string;
};

export type ExamDate = {
  subject: string;
  date: string; // ISO date
};

export type PlannerState = {
  goals: string[];
  subjects: string[];
  examDates: ExamDate[];
  tasks: Task[];
};

const DAY_MS = 24 * 60 * 60 * 1000;

function daysUntil(isoDate: string): number {
  return Math.ceil((new Date(isoDate).getTime() - Date.now()) / DAY_MS);
}

// Adds a subject to the list if it isn't there yet (case-insensitive).
// `?? []` covers agents created before `subjects` was added to state.
function withSubject(subjects: string[] | undefined, subject: string) {
  const list = subjects ?? [];
  return list.some((s) => s.toLowerCase() === subject.toLowerCase())
    ? list
    : [...list, subject];
}

// Strict YYYY-MM-DD check. `new Date("2026-02-30")` silently rolls over to
// March 2, so compare the parsed parts back to the input.
function isValidISODate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [, y, m, d] = match.map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
}

// Turns Workers AI / AI SDK errors into a message that is safe and useful to
// show in the chat. Workers AI error codes are prefixed to the message,
// e.g. "4006: you have used up your daily free allocation...".
function describeAIError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = /^(\d{4}):/.exec(message)?.[1];

  if (error instanceof Error && error.name === "AbortError") {
    return "Request was stopped.";
  }
  switch (code) {
    case "4006":
      return "The daily Workers AI free allowance (10,000 neurons) has been used up. It resets at 00:00 UTC. Try again later, or upgrade to the Workers Paid plan.";
    case "3036":
    case "3040":
      return "The AI model is busy or rate-limited right now. Please wait a moment and try again.";
    case "3007":
    case "3008":
      return "The AI model took too long to respond. Please try again.";
    case "5007":
      return "The configured AI model was not found. Check the model name in server.ts.";
  }
  if (/context|too long|max(imum)? (input|tokens)/i.test(message)) {
    return "The conversation is too long for the model. Click Clear to start a fresh chat.";
  }
  return "Something went wrong while talking to the AI model. Please try again.";
}

// Workaround for duplicated stream output.
// For Llama 3.3, Workers AI sends each streamed fragment twice in the same
// SSE event: once in OpenAI format (`choices[0].delta.content` /
// `choices[0].delta.tool_calls`) and once in legacy format (top-level
// `response` / `tool_calls`). workers-ai-provider reads both, so every
// fragment is emitted twice: text becomes "YourYour Physics Physics..." and
// tool-call JSON becomes invalid (e.g. `{"date": "{"date": "20...`).
// This wrapper drops each legacy copy when its OpenAI copy is present.
function dedupeStreamEvents(ai: Ai): Ai {
  const run = async (...args: Parameters<Ai["run"]>) => {
    const res: unknown = await ai.run(...args);
    if (!(res instanceof ReadableStream)) return res;

    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = "";

    const fixLine = (line: string) => {
      if (!line.startsWith("data: ")) return line;
      const data = line.slice(6);
      if (data === "[DONE]") return line;
      try {
        const event = JSON.parse(data);
        const delta = event.choices?.[0]?.delta;
        if (!delta) return line;
        let changed = false;
        if (typeof delta.content === "string" && "response" in event) {
          delete event.response;
          changed = true;
        }
        if (Array.isArray(delta.tool_calls) && "tool_calls" in event) {
          delete event.tool_calls;
          changed = true;
        }
        if (changed) return `data: ${JSON.stringify(event)}`;
      } catch {
        // Not JSON: pass it through unchanged
      }
      return line;
    };

    return (res as ReadableStream<Uint8Array>).pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        // Events can be split across chunks, so only handle complete lines
        transform(chunk, controller) {
          buffer += decoder.decode(chunk, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            controller.enqueue(encoder.encode(`${fixLine(line)}\n`));
          }
        },
        flush(controller) {
          buffer += decoder.decode();
          if (buffer) controller.enqueue(encoder.encode(fixLine(buffer)));
        }
      })
    );
  };
  return new Proxy(ai, {
    get: (target, prop) => {
      if (prop === "run") return run;
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

export class ChatAgent extends AIChatAgent<Env, PlannerState> {
  maxPersistedMessages = 100;
  chatRecovery = true;
  // Wait for MCP connections to be re-established after hibernation before
  // processing a message, so MCP tools aren't intermittently missing.
  waitForMcpConnections = true;

  // Initial memory for a brand new agent instance
  initialState: PlannerState = {
    goals: [],
    subjects: [],
    examDates: [],
    tasks: []
  };

  onStart() {
    // Configure OAuth popup behavior for MCP servers that require authentication
    this.mcp.configureOAuthCallback({
      customHandler: (result) => {
        if (result.authSuccess) {
          return new Response("<script>window.close();</script>", {
            headers: { "content-type": "text/html" },
            status: 200
          });
        }
        return new Response(
          `Authentication Failed: ${result.authError || "Unknown error"}`,
          { headers: { "content-type": "text/plain" }, status: 400 }
        );
      }
    });
  }

  @callable()
  async addServer(name: string, url: string) {
    return await this.addMcpServer(name, url);
  }

  @callable()
  async removeServer(serverId: string) {
    await this.removeMcpServer(serverId);
  }

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const mcpTools = this.mcp.getAITools();
    const workersai = createWorkersAI({
      binding: dedupeStreamEvents(this.env.AI)
    });

    const result = streamText({
      // LLM: Llama 3.3 on Workers AI
      model: workersai("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
        // If TypeScript complains about this option for this model, remove it.
        sessionAffinity: this.sessionAffinity
      }),
      system: `You are Study Planner, a friendly and practical study coach.
You help the user set study goals, track tasks, remember exam dates and build realistic weekly plans.

How to behave:
- Use your tools to read and change the user's data. Never invent tasks, goals or dates.
- Only act on the user's LATEST message. Earlier messages have already been handled; never repeat their tool calls.
- Do exactly what was asked, nothing extra:
  - An exam date -> call setExamDate only. Do NOT also create a task for it.
  - An explicit goal ("my goal is...") -> call addGoal only.
  - Something to do ("add a task...", "I need to...") -> call addTask once per distinct task.
- Call each tool at most once per item. When a tool returns successfully, the change is saved: do not call it again, just reply to the user.
- To change an exam date, call setExamDate with the subject and the new date; it replaces the old one.
- If a tool returns an "error", do not retry with the same input. Tell the user what was wrong and ask for the correct value.
- Before suggesting a plan or answering "what should I do", call listTasks or generateWeeklyPlan to see the saved data.
- Dates must be ISO format (YYYY-MM-DD). If the user says "next Friday" or "in 2 weeks", call getUserTimezone if needed and work out the date from today.
- Deleting tasks needs the user's approval, so just call deleteTask and let the UI ask.
- Keep replies short, encouraging and specific. Use bullet points for plans.

Current date and time: ${new Date().toISOString()}

${getSchedulePrompt({ date: new Date() })}

If the user asks for a reminder or a daily/weekly check-in, use the scheduleTask tool.`,
      // Prune old tool calls and reasoning to save tokens on long conversations
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        // Only prune bulky read-only results. Keep write calls (addTask,
        // setExamDate, ...) so the model can see what was already done and
        // doesn't redo earlier requests.
        toolCalls: [
          {
            type: "before-last-2-messages",
            tools: ["listTasks", "generateWeeklyPlan", "getScheduledTasks"]
          }
        ],
        reasoning: "before-last-message"
      }),
      tools: {
        // MCP tools from connected servers
        ...mcpTools,

        // Client-side tool: no execute function, the browser handles it
        getUserTimezone: tool({
          description:
            "Get the user's timezone from their browser. Use this when you need to know the user's local time.",
          inputSchema: z.object({})
        }),

        /* ---------------- Memory tools ---------------- */

        addGoal: tool({
          description: "Save a study goal the user wants to achieve.",
          inputSchema: z.object({
            goal: z.string().describe("The study goal, in one sentence")
          }),
          execute: async ({ goal }) => {
            this.setState({
              ...this.state,
              goals: [...this.state.goals, goal]
            });
            return { saved: goal, totalGoals: this.state.goals.length };
          }
        }),

        setExamDate: tool({
          description:
            "Save or update the exam date for a subject. Replaces any existing date for the same subject.",
          inputSchema: z.object({
            subject: z.string().describe("Subject name, e.g. 'Physics'"),
            date: z.string().describe("Exam date in YYYY-MM-DD format")
          }),
          execute: async ({ subject, date }) => {
            subject = subject.trim();
            date = date.trim();
            if (!subject) return { error: "Subject cannot be empty." };
            if (!isValidISODate(date)) {
              return {
                error: `"${date}" is not a valid date. Use YYYY-MM-DD, e.g. 2026-11-30.`
              };
            }
            const previous = this.state.examDates.find(
              (e) => e.subject.toLowerCase() === subject.toLowerCase()
            );
            if (previous?.date === date) {
              return {
                unchanged: true,
                subject: previous.subject,
                date,
                daysLeft: daysUntil(date)
              };
            }
            const others = this.state.examDates.filter((e) => e !== previous);
            // Keep the existing spelling of the subject when updating
            const name = previous?.subject ?? subject;
            this.setState({
              ...this.state,
              subjects: withSubject(this.state.subjects, name),
              examDates: [...others, { subject: name, date }]
            });
            return {
              subject: name,
              date,
              daysLeft: daysUntil(date),
              ...(previous
                ? { updated: true, previousDate: previous.date }
                : { added: true }),
              ...(daysUntil(date) < 0
                ? { warning: "This date is in the past." }
                : {})
            };
          }
        }),

        addTask: tool({
          description: "Add a study task to the user's task list.",
          inputSchema: z.object({
            title: z.string().describe("What needs to be done"),
            subject: z.string().describe("Subject the task belongs to"),
            dueDate: z
              .string()
              .optional()
              .describe("Optional due date in YYYY-MM-DD format")
          }),
          execute: async ({ title, subject, dueDate }) => {
            title = title.trim();
            subject = subject.trim();
            dueDate = dueDate?.trim() || undefined;
            if (!title) return { error: "Task title cannot be empty." };
            if (!subject) return { error: "Subject cannot be empty." };
            if (dueDate && !isValidISODate(dueDate)) {
              return {
                error: `"${dueDate}" is not a valid due date. Use YYYY-MM-DD.`
              };
            }
            // The model sometimes repeats a call; don't save the same
            // pending task twice.
            const same = (a: string, b: string) =>
              a.trim().toLowerCase() === b.trim().toLowerCase();
            const existing = this.state.tasks.find(
              (t) =>
                !t.done &&
                same(t.title, title) &&
                same(t.subject, subject) &&
                t.dueDate === (dueDate ?? null)
            );
            if (existing) {
              return {
                alreadyExists: existing,
                note: "This task is already saved. Do not add it again."
              };
            }
            const task: Task = {
              id: crypto.randomUUID().slice(0, 8),
              title,
              subject,
              dueDate: dueDate ?? null,
              done: false,
              createdAt: new Date().toISOString()
            };
            this.setState({
              ...this.state,
              subjects: withSubject(this.state.subjects, subject),
              tasks: [...this.state.tasks, task]
            });
            return { added: task };
          }
        }),

        listTasks: tool({
          description:
            "List the user's saved tasks, goals and exam dates. Use this before planning or answering questions about what is pending.",
          inputSchema: z.object({
            status: z
              .enum(["pending", "done", "all"])
              .default("pending")
              .describe("Which tasks to return")
          }),
          execute: async ({ status }) => {
            const tasks = this.state.tasks.filter((t) =>
              status === "all" ? true : status === "done" ? t.done : !t.done
            );
            return {
              tasks,
              goals: this.state.goals,
              subjects: this.state.subjects ?? [],
              examDates: this.state.examDates.map((e) => ({
                ...e,
                daysLeft: daysUntil(e.date)
              }))
            };
          }
        }),

        completeTask: tool({
          description: "Mark a task as done using its ID.",
          inputSchema: z.object({
            taskId: z.string().describe("The ID of the task")
          }),
          execute: async ({ taskId }) => {
            const task = this.state.tasks.find((t) => t.id === taskId);
            if (!task) return { error: `No task found with ID ${taskId}` };
            this.setState({
              ...this.state,
              tasks: this.state.tasks.map((t) =>
                t.id === taskId ? { ...t, done: true } : t
              )
            });
            return { completed: task.title };
          }
        }),

        // Human-in-the-loop: the UI asks the user to approve before this runs
        deleteTask: tool({
          description:
            "Permanently delete a task by its ID. Requires user approval.",
          inputSchema: z.object({
            taskId: z.string().describe("The ID of the task to delete")
          }),
          needsApproval: true,
          execute: async ({ taskId }) => {
            const task = this.state.tasks.find((t) => t.id === taskId);
            if (!task) return { error: `No task found with ID ${taskId}` };
            this.setState({
              ...this.state,
              tasks: this.state.tasks.filter((t) => t.id !== taskId)
            });
            return { deleted: task.title };
          }
        }),

        generateWeeklyPlan: tool({
          description:
            "Gather the data needed to build a 7-day study plan: pending tasks, overdue items, upcoming exams and goals. Call this when the user asks for a weekly plan, then write the plan from the result.",
          inputSchema: z.object({}),
          execute: async () => {
            const pending = this.state.tasks
              .filter((t) => !t.done)
              .map((t) => ({
                ...t,
                daysLeft: t.dueDate ? daysUntil(t.dueDate) : null
              }))
              .sort((a, b) => (a.daysLeft ?? 999) - (b.daysLeft ?? 999));

            return {
              today: new Date().toISOString().slice(0, 10),
              overdue: pending.filter(
                (t) => t.daysLeft !== null && t.daysLeft < 0
              ),
              pendingTasks: pending,
              upcomingExams: this.state.examDates
                .map((e) => ({ ...e, daysLeft: daysUntil(e.date) }))
                .filter((e) => e.daysLeft >= 0)
                .sort((a, b) => a.daysLeft - b.daysLeft),
              goals: this.state.goals,
              subjects: this.state.subjects ?? [],
              instruction:
                "Write a day-by-day plan for the next 7 days. Handle overdue and nearest-deadline items first, prioritise subjects with the closest exams, and keep each day to a realistic workload."
            };
          }
        }),

        /* ---------------- Scheduling tools ---------------- */

        scheduleTask: tool({
          description:
            "Schedule a reminder or study check-in for a later time. Use this when the user asks to be reminded or wants a recurring check-in.",
          inputSchema: scheduleSchema,
          execute: async ({ when, description }) => {
            if (when.type === "no-schedule") {
              return "Not a valid schedule input";
            }
            const input =
              when.type === "scheduled"
                ? when.date
                : when.type === "delayed"
                  ? when.delayInSeconds
                  : when.type === "cron"
                    ? when.cron
                    : null;
            if (!input) return "Invalid schedule type";
            try {
              this.schedule(input, "executeTask", description, {
                idempotent: true
              });
              return `Reminder scheduled: "${description}" (${when.type}: ${input})`;
            } catch (error) {
              return `Error scheduling reminder: ${error}`;
            }
          }
        }),

        getScheduledTasks: tool({
          description: "List all reminders that have been scheduled",
          inputSchema: z.object({}),
          execute: async () => {
            const tasks = this.getSchedules();
            return tasks.length > 0 ? tasks : "No scheduled reminders found.";
          }
        }),

        cancelScheduledTask: tool({
          description: "Cancel a scheduled reminder by its ID",
          inputSchema: z.object({
            taskId: z.string().describe("The ID of the reminder to cancel")
          }),
          execute: async ({ taskId }) => {
            try {
              this.cancelSchedule(taskId);
              return `Reminder ${taskId} cancelled.`;
            } catch (error) {
              return `Error cancelling reminder: ${error}`;
            }
          }
        })
      },
      stopWhen: stepCountIs(20),
      abortSignal: options?.abortSignal,
      // Log one concise line instead of the full error object
      onError: ({ error }) => {
        console.error(
          "[ChatAgent] LLM error:",
          error instanceof Error ? error.message : error
        );
      }
    });

    // The returned string is sent to the browser as the chat error message
    return result.toUIMessageStreamResponse({ onError: describeAIError });
  }

  // Runs when a scheduled reminder fires
  async executeTask(description: string, _task: Schedule<string>) {
    const pending = this.state.tasks.filter((t) => !t.done);
    const nextExam = this.state.examDates
      .map((e) => ({ ...e, daysLeft: daysUntil(e.date) }))
      .filter((e) => e.daysLeft >= 0)
      .sort((a, b) => a.daysLeft - b.daysLeft)[0];

    console.log(`Executing scheduled reminder: ${description}`);

    // broadcast() sends a live event to connected clients without adding to
    // the chat history, so the model doesn't see it as new input and loop.
    this.broadcast(
      JSON.stringify({
        type: "scheduled-task",
        description,
        timestamp: new Date().toISOString(),
        pendingTasks: pending.slice(0, 5).map((t) => t.title),
        pendingCount: pending.length,
        nextExam: nextExam ?? null
      })
    );
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
