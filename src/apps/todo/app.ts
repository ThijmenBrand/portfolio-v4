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
  // Handled in commands.ts.
  commands: [
    {
      id: "new",
      title: "New todo",
      keywords: ["add", "task", "todo", "remind"],
      input: { placeholder: "What needs doing? e.g. call mum fri 14:00 due 3/11", required: true },
    },
    // Offered by search: typing part of a todo's title.
    { id: "done", title: "Mark done", hidden: true },
  ],
  search: true,
} satisfies AppManifest;
