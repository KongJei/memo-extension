# Memo

Git-shared, Overleaf-style memo sidebar for VS Code.

## Install

Requirements:

- VS Code
- Node.js and npm

From this extension directory:

```sh
npm install
npm run compile
npx --yes @vscode/vsce package --no-dependencies
code --install-extension codex-memo-0.0.7.vsix --force
```

After installing, run `Developer: Reload Window` in VS Code.

## Usage

- Select text in an editor and press `Alt+M`, or right-click the selection and choose `Add Memo`.
- Type a memo and press `Enter` to save.
- Press `Esc` while drafting to cancel without saving.
- Use the search box at the top to search memo text, selected source text, file path, authors, and replies.
- Use the scope icon next to search to toggle between current-file search and all-file search.
- Use the filter icon to filter by `#tag`, `#color`, or `#user`.
- Tags are parsed from memo and reply text, for example `#todo`.
- Use the reply box at the bottom of a memo to add replies.
- Click a memo card to jump to the annotated source text.
- The sidebar shows only memos whose annotated start line is currently visible in the editor.
- Memo cards are vertically positioned in the sidebar according to the annotated start line.
- If memo cards would overlap, cards lower in source order are pushed down so every visible card remains readable.
- Click the check button on a root memo to resolve it by deleting the memo and all replies.
- Click the check button on a reply to delete only that reply.
- Use the three-dot menu on a memo or reply for `Edit` and `Delete`.
- Use the palette button on a root memo to change its color.

## Alignment Tuning

Memo cards are aligned from the annotated start line. VS Code does not expose exact editor pixel positions, so the extension estimates line positions from the visible range and sidebar height.

Use these settings when the cards need hard-coded correction:

```json
{
  "codexMemo.alignment.topOffsetPx": -12,
  "codexMemo.alignment.lineHeightPx": 0,
  "codexMemo.alignment.lineScale": 1,
  "codexMemo.alignment.cardAnchorOffsetPx": 0
}
```

- `topOffsetPx`: moves every memo card up or down. Use negative values when cards appear too low.
- `lineHeightPx`: overrides estimated line height. Leave `0` to auto-estimate.
- `lineScale`: stretches or compresses vertical spacing when lower cards drift more than upper cards.
- `cardAnchorOffsetPx`: shifts the card relative to its anchor line.

Alignment setting changes refresh automatically while the extension is running.

## Shared Data

Memos are stored in the git repo root at:

```text
.codex-memos/memos.json
```

The JSON stores only active memos. Resolved memos are deleted and are not retained.

To share memos with collaborators:

```sh
git add .codex-memos/memos.json codex-memo .gitignore
git commit -m "Add shared memo extension"
git push
```

Collaborators should pull the repo, install the extension with the commands above, and reload VS Code. When `.codex-memos/memos.json` changes after `git pull`, the extension reloads the memo sidebar and editor highlights.

## Development

```sh
npm install
npm run compile
```

Build artifacts are generated under `out/` and are ignored by git. Local VSIX files are also ignored.

## Issue

1. 코드 위치와 memo board 위치에 차이가 발생함, `topOffsetPx` 로도 조정 안됨
