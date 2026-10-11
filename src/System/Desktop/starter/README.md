# Building apps

Everything here runs inside the OS: write code in **Code**, run it, and
ship it as a single file.

## Run it

Open this folder in Code and press Run on `main.js`. You can also type
`./main.js` in a terminal here.

`console.log` goes to the terminal it was started from. Started from the
desktop, it has none: `cat /proc/<pid>/log` (pid from `ps`) shows the output.

The first line picks how the file runs:

| First line                | Runs as                                     |
| ------------------------- | ------------------------------------------- |
| `#!/ProgramFiles/jsapp`   | a GUI app in its own window                 |
| `#!/ProgramFiles/node`    | a command-line program (stdin/stdout/pipes) |
| `#!/ProgramFiles/sh`      | a shell script                              |

A JS program exports `main(os, args)`. `os` is the same API the built-in
apps use:

- `os.fs`: readTextFile, writeTextFile, readdir, mkdir…
- `os.io`: read and write fds 0, 1 and 2
- `os.process`: env, spawn, exit…
- `os.windows`: create, setTitle
- `os.dialog`: open
- `os.clipboard`: writeText, readText (reading needs a click or keypress)

## Imports

```js
import { helper } from "./lib.js";   // your own modules: ./ ../ or /absolute
import data from "./data.json";      // JSON as the default export
import page from "./page.html";      // HTML as a string: mount(html(page))
import "./style.css";                // GUI apps only
import { h, mount } from "os:ui";    // the OS's UI helpers
```

- npm packages and `fetch` aren't available. Apps are sandboxed and talk
  only to the OS.
- For the internet, ask the OS: `await os.net.fetch("https://…")` returns
  `{ status, contentType, body }` (body is bytes). https only, owner only
  (others get EPERM).
- Import cycles aren't supported.

## Look native

Plain HTML already matches the OS look: `button` (add `.primary` or
`.danger`), `input`, `select`, `textarea`, `.toolbar`, `.list > li`,
`.row`, `.card` and `.muted`.

There are two ways to build the UI:

- **Plain HTML:** write `page.html`, then call `mount(html(page))` and wire
  it up in JS with `document.querySelector("#save").onclick = …`.
  `<script>` tags in the HTML don't run, so keep the logic in `main.js`.
  Only use `html()` on markup you wrote yourself, never on user input.
- **From JS:** `h(tag, props, ...children)` builds elements, and
  `mount(...nodes)` fills the window.

## A command-line program

```js
#!/ProgramFiles/node
export async function main(os, args) {
  const text = new TextDecoder().decode(await os.io.read(0, 65536));
  await os.io.write(1, new TextEncoder().encode(text.toUpperCase()));
}
```

Then run `cat README.md | ./upper.js`.

## Ship it as one file

```sh
bundle main.js --install
```

This writes `Notes.app.js`: the whole app in one file, with the name, icon
and window size from `app.json`. `--install` also adds it to the app menu.

- Double-click the `.app.js` in Files to run it.
- Right-click → Download to save it outside the OS.
- Upload it into Files anywhere else to run it there.

To move a whole project folder instead, pack it: `tar -czf proj.tgz proj`,
and `tar -xzf proj.tgz` on the other side.

## More help

`man` lists every command's manual page; `man sh` covers the shell.
