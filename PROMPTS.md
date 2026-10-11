# AI Prompts Used

This project was built with help from an AI coding assistant (Claude Code). Below are the prompts I gave it, in order, each followed by a summary of its response and the changes it made.

---

## 1. Turn the starter into a Study Planner agent

**Prompt**

> This is the Cloudflare agents-starter. src/server.ts defines ChatAgent (AIChatAgent) using Workers AI. Turn it into a Study Planner agent:
>
> 1. Change the model to @cf/meta/llama-3.3-70b-instruct-fp8-fast and rewrite the system prompt for a study planner (remove the image/weather/calculator wording). Keep getSchedulePrompt.
> 2. Delete the getWeather and calculate demo tools.
> 3. Add persistent state (this.setState or this.sql) for: goals, subjects, exam dates, and tasks (id, title, subject, due date, done).
> 4. Add tools: addTask, listTasks, completeTask, deleteTask (needsApproval: true), setExamDate, and generateWeeklyPlan (uses saved tasks and dates).
> 5. Keep the schedule tools; make executeTask's reminder include pending tasks and make the UI show it as a notification.
> 6. Add a sidebar in the UI showing live tasks and exam dates from agent state.
> 7. Update the README with architecture notes mapping the 4 required components.
>
> Work in small steps, run the type checker after each, and don't deploy yet. Explain each change in one or two lines.

**Response summary**

- Found that `src/server.ts` already had most of items 1–4 (the model, the system prompt, `setState` storage, the planner tools and an extra `addGoal` tool), so it only filled the gaps.
- **State:** added `subjects: string[]` to `PlannerState`. It fills itself in from `addTask` and `setExamDate`, and `deleteTask` now uses the literal `needsApproval: true`.
- **Reminders:** `executeTask` broadcasts the pending tasks and the next exam. The UI shows them in a toast and, if the user allows it, a browser notification.
- **Sidebar:** added `PlannerSidebar` in `src/app.tsx`, kept in sync with the agent's state through `useAgent({ onStateUpdate })`. It shows exam countdowns, pending and overdue tasks, completed tasks, goals and an "Enable reminder notifications" button. The header and the example prompts were rebranded.
- **README:** rewritten with an architecture diagram and a table mapping the four components (LLM, workflow/coordination, chat input, memory/state) to the code.
- The type check passed after every step, then lint and a local `vite build`. Nothing was deployed.

---

## 2. Debugging a strange stream chunk

**Prompt**

> when giving prompt of My Physics exam is on 2026-11-20
> `{"body":"{\"type\":\"tool-input-delta\",...,\"inputTextDelta\":\"-\"}","done":false,...,"type":"cf_agent_use_chat_response"}`
> i see some errr please chekc it and find root cause

**Response summary**

- Replayed the prompt against the local dev server with a small WebSocket script, on a separate agent instance. Every `setExamDate` call came back with doubled JSON, e.g. `{"date": "{"date": "20220266--1111--20"...`. Parsing failed 20 times until the `stepCountIs(20)` limit.
- **Root cause:** logged the raw Workers AI stream. For Llama 3.3, each event carries every tool-call fragment twice: in `choices[0].delta.tool_calls` (OpenAI format) and in a top-level `tool_calls` array (older format). `workers-ai-provider` reads both, so every fragment was appended twice. Version 4.0.0 of the provider has the same code.
- **Fix:** a wrapper around `env.AI` that drops the duplicate top-level copy, reading the stream line by line because events can be split across chunks.

---

## 3. Reply text was duplicated

**Prompt**

> (pasted chat output where the reply read "YourYour Physics Physics exam exam is is on on 20220266--1111--2020.")
> i dont see the date is correct, please chekc and find root cause

**Response summary**

- The saved date was correct; only the reply text was doubled.
- **Root cause:** the same duplication, this time for text. Each event carries `choices[0].delta.content` and a top-level `response` field, and the provider emits both. The earlier fix only covered `tool_calls`, and the earlier test counted text chunks without reading them.
- **Fix:** renamed the wrapper to `dedupeStreamEvents()`. It now also drops the duplicate `response`, and each old-format field is dropped only when its OpenAI-format copy is in the same event.
- Verified by replaying prompts and reading the full reply text.

---

## 4. Why was Physics added as a task?

**Prompt**

> (pasted chat output with two identical `addTask` calls and an unrequested `setExamDate` for Physics)
> why physica have been added as task? root caouse

**Response summary**

- Physics was never stored as a task. It appeared because it's in `subjects` and `examDates`, and because the model called `setExamDate` again. In one test the model also invented a "Study for Physics exam" task.
- **Root cause, in three parts:**
  1. The system prompt was too loose ("when the user mentions X, call Y"), so Llama 3.3 acted on old messages and added things nobody asked for.
  2. `pruneMessages({ toolCalls: "before-last-2-messages" })` removed older tool calls from the history, so the model couldn't see that earlier requests were already done and repeated them.
  3. `addTask` added blindly, so a repeated call created a duplicate task.
- **Fixes:**
  - The prompt now says to act only on the latest message, do exactly what was asked, and not call a tool again after it succeeds.
  - Pruning now removes only the large read-only results (`listTasks`, `generateWeeklyPlan`, `getScheduledTasks`).
  - `addTask` skips a task identical to one that's already pending.
- Verified with four replays of a three-message conversation: each message triggered only the tool it asked for (one run also listed tasks after saving the exam), with no invented tasks, no duplicate tasks and no repeated `setExamDate`.

---

## 5. Updating an exam date, and error handling

**Prompt**

> update My Physics exam date to 2026-11-30
> will it work ??
> use error handleing
>
> (pasted `APICallError [AI_APICallError]: 4006: you have used up your daily free allocation of 10,000 neurons...`)

**Response summary**

- **Will it work?** Yes. `setExamDate` replaces the existing date for the same subject. The pasted error isn't a code bug: the account's daily Workers AI free allowance (10,000 neurons) was used up. It resets at 00:00 UTC. Clearing the long chat history makes each request cheaper.
- **Error handling added:**
  - **Server:** `describeAIError()` turns Workers AI error codes into clear messages: quota used up (4006), rate limits or capacity, timeouts, an unknown model and an over-long conversation. Other errors get a generic message. It's passed to `toUIMessageStreamResponse({ onError })`, and `streamText` logs one short line.
  - **Tools:** `isValidISODate()` strictly validates `YYYY-MM-DD`, rejecting rolled-over dates such as `2026-02-30`. `setExamDate` reports `added`, `updated` (with `previousDate`) or `unchanged`, and warns about past dates. `addTask` checks for empty fields and validates its due date.
  - **Prompt:** to change an exam date, call `setExamDate` with the new date; when a tool returns an error, explain it to the user instead of retrying.
  - **UI:** a dismissible red error banner in the chat, driven by `useAgentChat().error` and `clearError`.
- Verified against the live dev server while the quota error was active: the browser received the clear quota message instead of a crash. The date validator was unit-checked against valid and invalid inputs.

---

## 6. Recording the prompts

**Prompt**

> add into my prompts and response into @PROMPTS.md

**Response summary**

- Created this file.
