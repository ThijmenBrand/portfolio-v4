/**
 * Resume content — edit here, the app renders whatever is in this file.
 *
 * Source: "curriculum vitae - Thijmen Brand" (17-12-2025), with spelling
 * fixed. Deliberately NOT included on the public site: home address, phone
 * number and signature.
 */

export interface Entry {
  period: string;
  title: string;
  org: string;
  text?: string;
}

export interface Resume {
  name: string;
  headline: string;
  links: Array<{ label: string; href: string }>;
  experience: Entry[];
  education: Entry[];
  languages: Array<{ name: string; level: string }>;
  skills: string[];
  technologies: string[];
}

export const resume: Resume = {
  name: "Thijmen Brand",
  headline: "Software engineer · Application security",
  links: [
    { label: "thijmen@ik.nu", href: "mailto:thijmen@ik.nu" },
    { label: "linkedin.com/in/thijmen-brand", href: "https://linkedin.com/in/thijmen-brand" },
  ],
  experience: [
    {
      period: "September 2025 – February 2026",
      title: "3rd Party Software Compliance and Product Security",
      org: "ASML",
      text:
        "As an intern on the 3rd party software compliance team, my job was to recommend an " +
        "Application Security Posture Management (ASPM) solution to be used within ASML. Our " +
        "goals there were to become more compliant and gain better visibility into the security " +
        "posture of products. To achieve these goals, I benchmarked numerous solutions to find " +
        "the best fit for ASML's requirements.",
    },
    {
      period: "January 2022 – February 2025",
      title: "Software engineer",
      org: "Deloitte",
      text:
        "As a working student at Deloitte, I worked on the Enterprise Tax Platform. This " +
        "platform helps data analysts and engineers gain better insights into tax and allows " +
        "for better cooperation on data within teams. I worked with Azure Cloud, TypeScript, " +
        "Vue.js and ASP.NET. Later I shifted to a more security-focused role, advising the " +
        "development team on secure coding practices and vulnerabilities.",
    },
  ],
  education: [
    {
      period: "September 2021 – February 2026",
      title: "BSc Information and Communication Technologies",
      org: "Fontys University of Applied Sciences",
      text: "Specialized in Software Development and Cyber Security.",
    },
    {
      period: "February 2025 – July 2026",
      title: "Computer Science Minor",
      org: "Bern University of Applied Sciences",
      text: "Erasmus+ exchange program.",
    },
  ],
  languages: [
    { name: "Dutch", level: "Native" },
    { name: "English", level: "C1" },
    { name: "German", level: "A2" },
  ],
  skills: [
    "DevSecOps & SSDLC",
    "Frontend development",
    "Backend development",
    "Linux administration",
  ],
  technologies: ["C#", "PHP", "TypeScript", "JavaScript", "Go", "SQL", "Vue.js", "React"],
};
