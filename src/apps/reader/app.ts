import type { AppManifest } from "../../kernel/binfmt";

export default {
  window: { title: "Reader", width: 760, height: 640, minWidth: 280, minHeight: 200 },
  launcher: { name: "Reader", icon: "/assets/icons/reader.svg" },
} satisfies AppManifest;
