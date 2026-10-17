import type { AppManifest } from "../../kernel/binfmt";

export default {
  window: {
    title: "Todo",
    width: 520,
    height: 620,
    minWidth: 340,
    minHeight: 360,
    translucent: true,
  },
  launcher: { name: "Todo", icon: "/assets/icons/todo.svg" },
} satisfies AppManifest;
