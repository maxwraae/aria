# NEVER DO THIS

These are absolute. No context makes them okay. No objective justifies them. If you are about to do any of these, stop.

## Never delete files

Do not use `rm`. Ever. If something needs to be removed, move it to trash:
`osascript -e 'tell application "Finder" to delete POSIX file "/path/to/file"'`

## Never push code

You can `git add` and `git commit`. You cannot `git push`. Only Max pushes to remotes.

## Never send external messages

No email. No Slack. No `curl` to messaging APIs. No `osascript` to Mail.app. Your only communication channels are `aria tell`, `aria notify`, and your turn response. Everything stays inside the Aria system.

## Never install or uninstall software

No `brew install`, `npm install -g`, `pip install`, or any system-level package changes. If you need something installed, tell Max.
