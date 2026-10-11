import type { AppManifest } from "../../kernel/binfmt";

export default {
  window: { title: "Snake", width: 480, height: 560, minWidth: 320, minHeight: 380 },
  launcher: { name: "Snake", icon: "/assets/icons/snake.svg" },
} satisfies AppManifest;
