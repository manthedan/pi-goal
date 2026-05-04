# pi-goal roadmap

These are promising follow-up ideas that are intentionally not part of the first hardened fork pass.

## Interrupt behavior

When the user sends a normal message while a goal is active, Pi should avoid silently mixing that message into the autonomous goal loop. Possible UX:

- Auto-pause the current goal and handle the user message normally.
- Ask whether to pause the current goal and handle the new message.
- Ask whether to treat the new message as additional guidance for the active goal.

## Goal plan / task list

On goal start, ask the model to create explicit success criteria and a rough checklist. Persist the checklist as custom session state and update it across turns.

Completion should require checking off criteria with concrete evidence, not just calling `update_goal` after apparent progress.

## Goal templates

Add specialized goal modes with tailored continuation and completion criteria:

- `/goal bugfix ...`
- `/goal benchmark ...`
- `/goal refactor ...`
- `/goal research ...`

Each template could add focused instructions, evidence requirements, and anti-thrash heuristics for that kind of work.
