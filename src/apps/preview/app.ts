import type { AppManifest } from "../../kernel/binfmt";

export default {
  window: { title: "Preview", width: 720, height: 520, minWidth: 240, minHeight: 180 },
  launcher: { name: "Preview", icon: "/assets/icons/preview.svg" },
} satisfies AppManifest;
