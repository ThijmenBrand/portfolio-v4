/** Sidebar shortcuts shared by Files and the open dialog. "~" is $HOME. */
export const PLACES = [
  {
    label: "Home",
    path: "~",
    svg: '<path d="M3 8.5 10 3l7 5.5V16a1 1 0 0 1-1 1h-3.5v-5h-5v5H4a1 1 0 0 1-1-1z" />',
  },
  {
    label: "Desktop",
    path: "~/Desktop",
    svg: '<rect x="2.5" y="3.5" width="15" height="10.5" rx="1.5" /><path d="M7 17h6" />',
  },
  {
    label: "Documents",
    path: "~/Documents",
    svg: '<path d="M5 2.5h7l3.5 3.5v11a.5.5 0 0 1-.5.5H5a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5z" /><path d="M7.5 10h5M7.5 13h5" />',
  },
  {
    label: "Downloads",
    path: "~/Downloads",
    svg: '<path d="M10 3v10M6 9l4 4 4-4M4 17h12" />',
  },
  {
    label: "Pictures",
    path: "~/Pictures",
    svg: '<rect x="2.5" y="4" width="15" height="12" rx="1.5" /><circle cx="7" cy="8.5" r="1.5" /><path d="m3 14.5 4-4 3 3 2.5-2.5 4.5 4.5" />',
  },
  {
    label: "Music",
    path: "~/Music",
    svg: '<path d="M8 15V4.5l8-1.5V13" /><circle cx="6" cy="15" r="2" /><circle cx="14" cy="13" r="2" />',
  },
  {
    label: "Videos",
    path: "~/Videos",
    svg: '<rect x="2.5" y="5" width="11" height="10" rx="1.5" /><path d="m13.5 9 4-2.5v7l-4-2.5" />',
  },
  {
    label: "Applications",
    path: "/ProgramFiles",
    svg: '<rect x="3" y="3" width="5.5" height="5.5" rx="1.5" /><rect x="11.5" y="3" width="5.5" height="5.5" rx="1.5" /><rect x="3" y="11.5" width="5.5" height="5.5" rx="1.5" /><rect x="11.5" y="11.5" width="5.5" height="5.5" rx="1.5" />',
  },
  {
    label: "Temporary",
    path: "/tmp",
    svg: '<circle cx="10" cy="10" r="7" /><path d="M10 6v4l2.5 2" />',
  },
  {
    label: "Computer",
    path: "/",
    svg: '<rect x="2.5" y="4" width="15" height="10" rx="1.5" /><path d="M7 17h6M10 14v3" />',
  },
];
