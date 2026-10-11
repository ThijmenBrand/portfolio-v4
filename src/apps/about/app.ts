import type { AppManifest } from "../../kernel/binfmt";

export default {
  window: {
    title: "System Info",
    width: 460,
    height: 420,
    minWidth: 400,
    minHeight: 360,
  },
  launcher: { name: "System Info", icon: "/assets/icons/about.svg" },
} satisfies AppManifest;
