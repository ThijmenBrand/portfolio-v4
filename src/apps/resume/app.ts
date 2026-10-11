import type { AppManifest } from "../../kernel/binfmt";

export default {
  window: {
    title: "Resume — Thijmen Brand",
    x: 170,
    y: 40,
    width: 760,
    height: 640,
    minWidth: 380,
    minHeight: 320,
  },
  launcher: { name: "Resume", icon: "/assets/icons/resume.svg" },
} satisfies AppManifest;
