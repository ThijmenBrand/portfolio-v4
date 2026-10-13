import type { AppManifest } from "../../kernel/binfmt";

export default {
  window: { title: "Dev Toolbox", width: 760, height: 560, minWidth: 360, minHeight: 360 },
  launcher: { name: "Dev Toolbox", icon: "/assets/icons/devtools.svg" },
} satisfies AppManifest;
