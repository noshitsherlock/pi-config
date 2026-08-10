# TODO

## Sharing Skills

I currently have duplicated skills both in Claude & PI.

Here I have skills under `~/.pi/agent/skills` and for Claude under `~/.claude/skills`

It would be possible to also store all the skills under `~/.agents/skills/` so that Claude and PI can share them.

## Git worktree support

Add command to /fork or /new a session into a worktree.
This should create a new git worktree under .worktrees/<branch_name> and open up Pi inside this worktree.
The new PI inside the worktree is going to be opened as a split pane in tmux.

For merging changes from a worktree back into the main branch, see
[WORKTREE_MERGE_WORKFLOW.md](./WORKTREE_MERGE_WORKFLOW.md).

## Compare implementations

When I do multiple implementations from the same SPEC I would like a good way to compare the two.

Example would be I have two different .worktrees with the different implementations of the same thing.

## Git guard

~~Git guard should not alert for a file that it has already touched this session.~~ Fixed: session-touched files are now tracked in a `Set` and bypassed on subsequent write/edit calls.

~~Still manages to do destructive git commands~~ Fixed: `git rm -f` / `git rm --force` added to `DESTRUCTIVE_GIT_PATTERNS`.

## Formatting of design spec markdowns

I'm running into where design documents and other markdown documents are formatted by breaking line lengths.
Not sure what this is coming from. Need to investigate

## Agent Observer
I would like to connect an agent to the current workflow of another agent to continue build on what that agent is currently producing or writing.

You select a session to connect to.
The new agent is listening to the whole conversation and can make continued work or monitoring of what that agent is working on.

For example:

read stream from <session_id> | run agent connected to that stream and use its output and a source of information/context.



## Extensions and Skill replacements
ogulcancelik removed the pi web plugin with a skill. I would like to try that out instead of using the extension.

There are also some other extensions that are interesting like `pi-session-recall`
- https://github.com/ogulcancelik/pi-extensions
- https://github.com/ogulcancelik/agent-skills


## /recap

I would like a similar skill in Pi as clauds recap feature

## Change ci from skill to script

Consider rewriting pi-ai-commit to a script like q-pi
See ~/Dev/scripts/q-pi

## Disable model invocation support
Add extension for handle skills that can not be invoked using human
```yaml
disable-model-invocation: true
```

This is part of the standard that I think Claude Code invokes. It is not part of the SKILLs standard that Pi uses.

Also not executing `!<command>` inside skills.
