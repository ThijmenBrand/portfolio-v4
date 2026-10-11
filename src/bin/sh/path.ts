/**
 * Where bare command names are looked up, in order. Shared by sh (exec) and
 * the terminal (tab completion). /System is deliberately not on it, like
 * /sbin: run those by full path.
 */
export const PATH = ["/ProgramFiles"];
