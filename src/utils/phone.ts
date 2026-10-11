// Phone mode: windows act like phone apps (always fullscreen, no drag/resize).
// Keep in sync with the same media query in kernel/windows/gui/window.css and System/Taskbar/taskbar.css.
// ponytail: media-query heuristic; add a Settings toggle if tablets want floating windows.
export const PHONE_QUERY = "(max-width: 700px), (pointer: coarse) and (max-width: 1024px)";

export const isPhone = (): boolean => matchMedia(PHONE_QUERY).matches;
