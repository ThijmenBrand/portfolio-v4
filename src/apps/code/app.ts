import type { AppManifest } from "../../kernel/binfmt";

export default {
  window: { title: "Code", width: 960, height: 620, minWidth: 520, minHeight: 320 },
  desktop: { name: "Code", icon: "/assets/icons/code.svg" },
} satisfies AppManifest;
