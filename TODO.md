# BYOTeX.AI roadmap

Planned features, in the order they should be built. The order puts **high value for little work** first, then follows dependencies: each phase builds on what the previous one adds. Effort is a rough size: **S** = a few hours, **M** = a day or two, **L** = several days.

Suggestions and pull requests are welcome; open an issue to discuss bigger items first.

---

## Phase 1: Quick wins

Small changes with immediate everyday value, using parts the app already has.

- [ ] **Model check button** · S
  In Settings, a **Check** button next to each model sends a tiny request (about 1 output token) and shows "OK" or the provider's error before you choose it. Models that failed are marked in the **List...** picker.
  *Why first:* model names go out of date often (the Gemini 404 came from exactly this), and testing a model today means sending a real prompt.

- [ ] **Per-project custom instructions** · S
  A file `.byotex/instructions.md` in the project, editable from Settings, added to every request, with rules such as "IEEE style, British spelling, abstract ≤ 200 words, use `\cref`". The fixed edit-format rules stay locked so the diff engine keeps working.
  *Why first:* it's the cheapest way to make every AI answer fit the paper, and it travels with the project.

- [ ] **Prompt caching (Anthropic, OpenAI)** · S
  Mark the stable part of each request (system prompt, project outline, file context) as cacheable, so re-sending the same manuscript costs much less and responds faster. Show cache hits in the token log.
  *Why first:* a small change with a direct cost saving for every user with an API key.

- [ ] **Word counts** · S
  Per section and for the whole paper (from the existing outline parser, skipping commands, comments and math), shown in the Outline and the status bar. An optional limit per section gives warnings like "abstract: 212 / 200 words".

- [ ] **More project checks** · S
  Added to **Problems**: BibTeX entries never cited, figures and tables never referenced, duplicate labels, and overfull boxes grouped by section (already parsed from the TeX log).

- [ ] **Saved prompts** · S
  A small library of reusable requests ("Check tense consistency", "Tighten related work"), with a few built-in ones and the option to add your own, per project or global. One click fills the chat box.

## Phase 2: Writing helpers

The main writing features. They build on the CodeMirror editor and on Phase 1's custom instructions and saved prompts.

- [ ] **Quick actions on selected text** · M
  Right-click a selection in the editor → *Shorten*, *Make formal*, *Fix grammar*, *Explain this equation*. Each runs as a normal chat request scoped to the selected lines and comes back as a reviewable diff (or as an answer, for *Explain*).
  *Depends on:* CodeMirror (done), saved prompts (the actions are built-in prompts).

- [ ] **Review mode** · M–L
  "Review my paper" returns **comments pinned to lines** instead of edits: clarity, unsupported claims, missing citations, inconsistent notation. They appear as margin markers in the editor and as a list you can work through and dismiss, like a co-author's notes. A comment can be turned into an edit request with one click.
  *Depends on:* a structured comment format alongside the EDIT blocks; CodeMirror gutter markers.

- [ ] **Text selection and search in the PDF preview** · M
  Add PDF.js's text layer so you can select and copy text from the PDF and search it (Ctrl/Cmd+F while the PDF has focus). Search results also give another way to jump to the source via SyncTeX.

- [ ] **Cost and usage tracker** · M
  Tokens and estimated cost per provider, per day and per project, from the usage numbers already collected for each request (with cache savings from Phase 1). A small report window, plus an optional monthly budget warning.
  *Depends on:* a price table per model, which the user can edit, since prices change.

## Phase 3: Publishing workflow

For submitting and revising. These build on the compiler integration and on the History backups.

- [ ] **arXiv / journal export** · M
  One click builds a ready-to-upload `.zip`:
  - merges `\input`/`\include` files (optional) and includes the compiled `.bbl`;
  - removes comments, and checks figure formats (for example, no `.eps` with pdfLaTeX);
  - leaves out build files and backups;
  - test-compiles the result in a clean folder and reports problems before you upload.

- [ ] **Change-marked PDF (latexdiff)** · M
  Choose two versions (from **History**, a saved snapshot or a git commit) and produce a PDF with insertions and deletions marked, as journals often ask for with a revision. Uses `latexdiff` (part of TeX Live), with an option to flatten `\input` files first.
  *Depends on:* History (done); it works better with Git integration.

- [ ] **Git integration** · M–L
  See changed files and their diffs, write a commit message (with an optional AI-suggested one), commit, pull and push, all from inside the app. Show the current branch in the status bar. Never push without a click.

## Phase 4: Reach and polish

Bigger or less urgent work that makes the app easier for more people to use.

- [ ] **Grammar and spelling (LanguageTool)** · L
  Check prose with LanguageTool running on your own computer, so the text stays private. It should skip LaTeX commands, math and citations; show results as underlines in the editor with suggestions; and offer a language/variant choice (British or US English).
  *Why later:* the local server needs Java and a large download, which makes setup the hard part. Start with an optional "connect to a LanguageTool server" setting.

- [ ] **A real desktop app (Electron or Tauri)** · L
  Package the app so people double-click an icon instead of using a terminal, with installers for macOS, Windows and Linux, built by the existing CI. Tauri gives a smaller download; Electron is simpler to set up with the current Node backend.
  *Why later:* it matters most once the feature set is stable, and it brings code-signing and auto-update work with it.

- [ ] **Themes** · S
  Windows 95, high contrast (for accessibility), and a dark "Windows 98 at night" mode, built on the existing colour variables and Fonts & Colors settings.
  *Why last:* cosmetic, and quick to do whenever someone wants it.

---

## Done

- [x] Bring-your-own-AI chat with reviewable per-hunk diffs (Anthropic, OpenAI, Gemini, OpenRouter, local models, OpenCode free models)
- [x] Compile with `latexmk`, PDF.js preview, SyncTeX in both directions
- [x] Document outline following `\input`/`\include`; citation, label and figure checks
- [x] Encrypted key storage; local-only server; session token with automatic renewal
- [x] LaTeX installation help (detects MacTeX, TeX Live, MiKTeX, TinyTeX; installs TinyTeX)
- [x] CodeMirror editor: highlighting, find & replace, autocomplete for `\ref`, `\cite`, `\begin`
- [x] Verified citations from Crossref and arXiv (Find Reference)
- [x] History panel with diff and restore
- [x] Find and install missing LaTeX packages
- [x] CI on macOS, Windows and Linux
