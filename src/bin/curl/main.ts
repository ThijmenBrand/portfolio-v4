// curl — fetch a URL through os.net.fetch (https only, admin or root).
// curl [-X GET|HEAD|POST] [-d body] [-H 'Content-Type: t'] [-o file] [-s] [-i] [-I] url
import type { AppInterface } from "../../kernel/syscalls/api";
import { errorCode, print } from "../lib/input";

const USAGE = "usage: curl [-X GET|HEAD|POST] [-d body] [-H 'Content-Type: type'] [-o file] [-s] [-i] [-I] url\n";

export async function main(os: AppInterface, args: string[]): Promise<void> {
  let method: "GET" | "HEAD" | "POST" | undefined;
  let body: string | undefined;
  let contentType: string | undefined;
  let output: string | undefined;
  let silent = false;
  let include = false;
  let url: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-X") method = args[++i]?.toUpperCase() as typeof method;
    else if (a === "-d" || a === "--data") body = args[++i];
    else if (a === "-o") output = args[++i];
    else if (a === "-s") silent = true;
    else if (a === "-i") include = true;
    else if (a === "-I") (method = "HEAD"), (include = true);
    else if (a === "-H") {
      // Only Content-Type gets through the proxy; other headers are refused, not dropped.
      const [name, ...value] = (args[++i] ?? "").split(":");
      if (name?.trim().toLowerCase() !== "content-type") {
        await print(os, 2, `curl: only the Content-Type header is supported\n`);
        return os.process.exit(2);
      }
      contentType = value.join(":").trim();
    } else if (!a.startsWith("-") && !url) url = a;
    else {
      await print(os, 2, USAGE);
      return os.process.exit(2);
    }
  }
  method ??= body !== undefined ? "POST" : "GET";
  if (!url || !["GET", "HEAD", "POST"].includes(method)) {
    await print(os, 2, USAGE);
    return os.process.exit(2);
  }
  if (!url.includes("://")) url = `https://${url}`;

  let response;
  try {
    response = await os.net.fetch(url, { method, body, contentType });
  } catch (error) {
    const code = errorCode(error);
    const why = code === "EPERM" ? "network access needs root or the admin group (try sudo)" : (error as Error).message || code;
    await print(os, 2, `curl: ${why}\n`);
    return os.process.exit(code === "EPERM" ? 1 : 6);
  }

  if (include) await print(os, 1, `HTTP ${response.status}\ncontent-type: ${response.contentType}\n\n`);
  try {
    if (output) await os.fs.writeFile(output, response.body);
    else await os.io.write(1, response.body);
  } catch (error) {
    if (errorCode(error) === "EPIPE") return os.process.exit(0);
    await print(os, 2, `curl: ${output ?? "stdout"}: ${errorCode(error)}\n`);
    return os.process.exit(23);
  }
  // Like curl -f: an HTTP error is a failure, so `curl x && ...` behaves.
  if (response.status >= 400) {
    if (!silent) await print(os, 2, `curl: HTTP ${response.status}\n`);
    return os.process.exit(22);
  }
  await os.process.exit(0);
}
