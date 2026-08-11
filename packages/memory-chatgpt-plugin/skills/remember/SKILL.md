---
name: remember
description: Explicitly store or recall a memory when the user says "remember this", "remember that", "what do you remember about", "recall", or asks you to save something for later.
---

# Remember

The user explicitly asked you to remember or recall something. Use the memory
tools to fulfill their request.

## Trigger phrases

- "Remember that..." / "Remember this..."
- "Don't forget that..."
- "Save this for later"
- "What do you know about..." / "What do you remember about..."
- "Do you remember..."
- "Recall..."
- "Look up..." / "Find what I said about..."
- "What did we decide about..."

## When the user says "remember this"

1. Call `memory_search` with the topic to check if a similar memory exists.
2. If found, use `memory_update` with `appendContent: true` to add the new
   information.
3. If not found, use `memory_add`:
   - Pick a descriptive `key` based on the content.
   - Use the `facts` namespace for general facts, `preferences` for
     preferences, `decisions` for decisions.
   - Add relevant `tags`.
4. Confirm to the user: "Saved. I'll remember this for future conversations."

## When the user asks "what do you remember about X"

1. Call `memory_search` with query "X".
2. If results are found, summarize what you know:
   "Here's what I remember about X:
   - [memory 1 summary]
   - [memory 2 summary]
   Is there anything else you'd like me to recall or update?"
3. If no results, say: "I don't have any memories about X yet. Would you like
   to tell me about it so I can save it?"

## When the user says "do you remember..."

1. Call `memory_search` with the key terms from their question.
2. If found, answer using the stored memory.
3. If not found, be honest: "I don't have that stored in memory. It may have
   been before memory tracking was enabled, or it wasn't saved."

## When the user says "forget..." or "delete..."

1. Call `memory_search` to find the relevant memory.
2. If found, call `memory_delete` with the key.
3. Confirm: "Deleted that memory."

## When the user says "update what you know about X"

1. Call `memory_search` with "X" to find existing memories.
2. Show the user what's currently stored.
3. Ask what they'd like to change.
4. Use `memory_update` to replace content or `appendContent: true` to add.

## Example

User: "Remember that I prefer tabs over spaces for TypeScript but spaces for Python."

→ Call `memory_search` with "tabs spaces preference"
→ No existing memory found
→ Call `memory_add`:
  - key: `preference-indentation-tabs-spaces`
  - namespace: `preferences`
  - tags: `["indentation", "typescript", "python", "coding-style"]`
  - content: `User prefers tabs for TypeScript, spaces for Python.`
→ Respond: "Saved. I'll remember: tabs for TypeScript, spaces for Python."

User: "What do you remember about my setup?"

→ Call `memory_search` with "setup environment workspace"
→ Returns memories about timezone, editor, OS, tools
→ Respond: "Here's what I remember about your setup:
  - Timezone: Asia/Seoul
  - OS: Windows
  - Editor: VS Code with dark mode
  - Shell: PowerShell
  Anything you'd like me to update?"
