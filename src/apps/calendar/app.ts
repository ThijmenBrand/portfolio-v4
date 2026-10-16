import type { AppManifest } from "../../kernel/binfmt";

export default {
  window: {
    title: "Calendar",
    width: 980,
    height: 680,
    minWidth: 360,
    minHeight: 380,
    translucent: true,
  },
  launcher: { name: "Calendar", icon: "/assets/icons/calendar.svg" },
} satisfies AppManifest;
