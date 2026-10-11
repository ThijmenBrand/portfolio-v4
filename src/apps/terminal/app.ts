import type { AppManifest } from "../../kernel/binfmt";

export default {
  window: { title: "Terminal", width: 680, height: 440, minWidth: 360, minHeight: 220 },
  desktop: { name: "Terminal", icon: "/assets/icons/terminal.png" },
} satisfies AppManifest;
