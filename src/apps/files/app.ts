import type { AppManifest } from "../../kernel/binfmt";

export default {
  window: { title: "Files", width: 820, height: 520, minWidth: 520, minHeight: 320 },
  desktop: { name: "Files", icon: "/assets/icons/files.svg" },
} satisfies AppManifest;
