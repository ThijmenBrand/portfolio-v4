import type { AppManifest } from "../../kernel/binfmt";

export default {
  window: { title: "Terminal", width: 680, height: 440, minWidth: 360, minHeight: 220 },
  launcher: { name: "Terminal", icon: "/assets/icons/terminal.svg" },
} satisfies AppManifest;
