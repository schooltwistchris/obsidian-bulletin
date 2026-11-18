# Bulletin

Pull message boards and their comments from [Basecamp](https://basecamp.com) into your Obsidian vault.

Bulletin is an independent plugin that works with Basecamp. It is not made, endorsed or supported
by 37signals.

## What it does

- Writes one note per message: `Basecamp/<Project>/Messages/<date> <title>.md`.
- Puts the message's comments under a **Comments** heading in the same note. Each comment is a
  `[!comment]` callout with the author and date as its title, so comments stay apart in both editing
  and reading view. Notes written by an older version switch to this layout the next time their
  message changes in Basecamp.
- Adds properties: `basecamp_id`, `basecamp_url`, `project`, `author`, `created`, `updated` and
  `comments`, plus `bulletin_hash`, a fingerprint Bulletin uses to tell whether you've edited the
  note, and `cssclasses: bulletin`, so themes and CSS snippets can style Bulletin's notes.
- Converts Basecamp formatting to Markdown. Mentions become `@Name` and highlights become
  `==highlight==`. Images and files become links back to Basecamp; they aren't downloaded.
- On later pulls, fetches only messages that are new or have changed since the last pull, including
  messages with new comments.
- Renames a note when its message's title changes, and updates links to it.
- **Never overwrites your edits.** If you've changed a note since Bulletin last wrote it, the note
  is skipped and counted in the summary. Changing a note's properties counts as an edit.
- Recognizes notes it wrote before by `basecamp_id`, so reinstalling Bulletin or moving notes
  doesn't create duplicates.

Bulletin only reads from Basecamp. It never creates, edits or deletes anything there.

## Requirements

- A Basecamp account.
- Obsidian 1.13.1 or later, **on desktop**. Mobile isn't supported yet: signing in uses a local web
  server on your computer, which phones don't allow.

## Getting started

1. Install and enable Bulletin from **Settings → Community plugins**.
2. In **Settings → Bulletin**, choose **Connect**. Your browser opens Basecamp. Pick an account and
   approve read-only access, then return to Obsidian.
3. Optional: change the folder, or turn off **All projects** and pick the projects you want.
4. Open the command palette and run **Bulletin: Pull new and changed messages**.

Commands:

- **Pull new and changed messages**: the normal pull.
- **Check every message again**: looks at every message, not only recent ones. Notes you've edited
  are still skipped.

Each connection covers one Basecamp account. To switch accounts, disconnect and connect again.

## Privacy and network use

Bulletin needs the network to read your Basecamp data. It talks only to Basecamp:

| Service | What for |
|---|---|
| `app.basecamp.com` | Registering the plugin with Basecamp the first time you connect, signing in, and renewing your sign-in. |
| `3.basecampapi.com` | Reading your account name, projects, messages and comments. |

Also:

- **Local sign-in listener.** While you connect, Bulletin briefly runs a web server on your computer
  at `127.0.0.1` on a random port. It receives Basecamp's sign-in response and then shuts down. It
  only accepts connections from your own computer.
- **Read-only access.** Bulletin asks Basecamp for the `read` scope only.
- **Where your sign-in is kept.** Access tokens are stored in Obsidian's secret storage on this
  device, not in the plugin's settings file, so they don't travel with your vault. Connect once on
  each computer.
- **Finding its own notes.** If Bulletin loses track of a note (after a reinstall, or if you move
  it), it checks your notes' properties for a matching `basecamp_id`. It reads file names and
  properties only, never note contents.
- **No telemetry.** Bulletin has no analytics or tracking, and no server of its own. Your data goes
  from Basecamp straight into your vault.
- **Disconnecting** removes the sign-in from this device. To revoke Bulletin's access entirely,
  remove it from your connected apps in Basecamp.

## Development

```bash
npm install
npm run dev     # rebuilds main.js on change
npm test        # unit tests
npm run build   # typecheck and production build
```

## License

[MIT](LICENSE)
