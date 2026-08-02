export class KernelError extends Error {
  public readonly code: string;
  public readonly name: string;
  public readonly message: string;
  public readonly details?: any;

  constructor(code: string, message: string, details?: any) {
    super(message);
    this.name = "KernelError";
    this.message = message;
    this.details = details;
    this.code = code;
  }
}

export function isKernelError(error: unknown): error is KernelError {
  return error instanceof KernelError;
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

export function kernelError(code: string, message: string): KernelError {
  return new KernelError(code, message);
}

export function enoent(path: string): KernelError {
  return new KernelError("ENOENT", `No such file or directory: ${path}`, {
    path,
  });
}

export function esrch(pid: number): KernelError {
  return new KernelError("ESRCH", `No such process: ${pid}`, {
    pid,
  });
}

export function einval(arg: string): KernelError {
  return new KernelError("EINVAL", `Invalid argument: ${arg}`, {
    arg,
  });
}

export function eperm(pid: number, syscall?: string): KernelError {
  return new KernelError(
    "EPERM",
    `Operation not permitted for process: ${pid}${syscall ? ` (${syscall})` : ""}`,
    {
      pid,
      syscall,
    },
  );
}

export function enoexec(path: string): KernelError {
  return new KernelError("ENOEXEC", `File is not executable: ${path}`, {
    path,
  });
}

export function eintr(pid: number): KernelError {
  return new KernelError("EINTR", `Process ${pid} was interrupted`, {
    pid,
  });
}

export function eexist(path: string): KernelError {
  return new KernelError("EEXIST", `File already exists: ${path}`, {
    path,
  });
}

export function enotdir(path: string): KernelError {
  return new KernelError("ENOTDIR", `Not a directory: ${path}`, {
    path,
  });
}

export function eisdir(path: string): KernelError {
  return new KernelError("EISDIR", `Is a directory: ${path}`, {
    path,
  });
}

export function enotempty(path: string): KernelError {
  return new KernelError("ENOTEMPTY", `Directory not empty: ${path}`, {
    path,
  });
}

export function ebadf(path: string): KernelError {
  return new KernelError("EBADF", `Bad file descriptor: ${path}`, {
    path,
  });
}

export function erofs(path: string): KernelError {
  return new KernelError("EROFS", `Read-only file system: ${path}`, {
    path,
  });
}

export function ebusy(path: string): KernelError {
  return new KernelError("EBUSY", `Resource busy: ${path}`, {
    path,
  });
}
