export class KernelError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    message = `[${code}] ${message}`;
    super(message);
    this.name = "KernelError";
    this.code = code;
  }

  public isKernelError(): this is KernelError {
    return true;
  }
}

export function logError(error: unknown): void {
  if (error instanceof KernelError) {
    console.error(`KernelError: ${error.code} - ${error.message}`);
  } else if (error instanceof Error) {
    console.error(`Error: ${error.name} - ${error.message}`);
  } else {
    console.error(`Unknown error: ${String(error)}`);
  }
}

export function kernelError(
  message: string,
  code: string = "ERROR",
): KernelError {
  return new KernelError(code, message);
}

export function enoent(path: string): KernelError {
  return new KernelError("ENOENT", `No such file or directory: ${path}`);
}

export function esrch(pid: number): KernelError {
  return new KernelError("ESRCH", `No such process: ${pid}`);
}

export function einval(arg: string): KernelError {
  return new KernelError("EINVAL", `Invalid argument: ${arg}`);
}

export function eperm(pid: number, syscall?: string): KernelError {
  return new KernelError(
    "EPERM",
    `Operation not permitted for process: ${pid}${syscall ? ` (${syscall})` : ""}`,
  );
}

export function noexec(path: string): KernelError {
  return new KernelError("NOEXEC", `File is not executable: ${path}`);
}

export function eintr(pid: number): KernelError {
  return new KernelError("EINTR", `Process ${pid} was interrupted`);
}
