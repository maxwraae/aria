const FONTS = {
  sans: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif",
  mono: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
} as const;

const AGENT_FONT_SIZE = 13;

export const theme = {
  fonts: FONTS,

  colors: {
    /** Needs-input / interactive accent */
    blue: "#007AFF",
    /** Thinking / processing */
    amber: "#FF9F0A",
    /** Card / surface background */
    surface: "#FFFFFF",
    /** Page background */
    background: "hsl(30,22%,90%)",
    /** Thinking glow tint */
    thinkingGlow: "rgba(251, 191, 36, 0.03)",
    /** User message pill */
    userPill: "#F0F0F0",
    /** Code block / tool pill background */
    codeBg: "#F8F8FA",
    /** Tool pill background */
    toolPillBg: "#F5F5F5",
    /** Card header background — pure white, no gray */
    headerBg: "#FFFFFF",
    /** Text */
    textPrimary: "rgba(0,0,0,0.75)",
    textSecondary: "rgba(0,0,0,0.40)",
    textAgent: "rgba(0,0,0,0.75)",
    textTool: "rgba(0,0,0,0.45)",
    /** Figure card background */
    figureBg: "#F5F5F7",
    /** Figure card shadow */
    figureShadow: "0 1px 3px rgba(0,0,0,0.06), 0 0 0 0.5px rgba(0,0,0,0.04)",
    /** Figure drawer divider */
    figureDivider: "rgba(0,0,0,0.06)",
    /** Failed / error state */
    failed: "#FF3B30",
  },

  typography: {
    /** Agent markdown prose body */
    agentProse: {
      fontSize: AGENT_FONT_SIZE,
      fontWeight: "400" as const,
      lineHeight: 17,
      color: "rgba(0,0,0,0.75)",
      fontFamily: FONTS.sans,
    },
    /** User message pill text */
    userMessage: {
      fontSize: AGENT_FONT_SIZE,
      fontWeight: "400" as const,
      color: "rgba(0,0,0,0.85)",
      lineHeight: 18,
      fontFamily: FONTS.sans,
    },
    /** Code block body text */
    codeBlock: {
      fontSize: 11,
      fontFamily: FONTS.mono,
      color: "rgba(0,0,0,0.70)",
      lineHeight: 18,
    },
    /** Code block language label */
    codeBlockLanguage: {
      fontSize: 10,
      color: "rgba(0,0,0,0.30)",
      fontFamily: FONTS.sans,
    },
    /** Code block copy button */
    codeBlockCopy: {
      fontSize: 11,
      color: "rgba(0,0,0,0.25)",
      fontFamily: FONTS.sans,
    },
    /** Trace pill label */
    toolPill: {
      fontSize: 14,
      fontWeight: "500" as const,
      color: "rgba(0,0,0,0.55)",
      fontFamily: FONTS.sans,
    },
    /** Trace pill icon */
    toolPillIcon: {
      fontSize: 13,
      color: "rgba(0,0,0,0.35)",
      fontFamily: FONTS.sans,
    },
    /** Expanded tool detail rows */
    toolExpandedName: {
      fontSize: 11,
      fontWeight: "500" as const,
      color: "rgba(0,0,0,0.35)",
      fontFamily: FONTS.sans,
    },
    toolExpandedDetail: {
      fontSize: 11,
      color: "rgba(0,0,0,0.25)",
      fontFamily: FONTS.mono,
    },
    toolExpandedStatus: {
      fontSize: 11,
      color: "rgba(0,0,0,0.25)",
      fontFamily: FONTS.sans,
    },
    /** Promoted pill detail line */
    promotedDetail: {
      fontSize: 12,
      fontWeight: "400" as const,
      fontFamily: FONTS.sans,
    },
    /** Promoted pill code text */
    promotedCode: {
      fontSize: 11,
      fontFamily: FONTS.mono,
      color: "rgba(255,255,255,0.60)",
      lineHeight: 18,
    },
    /** Promoted pill result text */
    promotedResult: {
      fontSize: 12,
      color: "rgba(255,255,255,0.50)",
      fontFamily: FONTS.sans,
    },
    /** Card title in glass pill */
    cardTitle: {
      fontSize: 14,
      fontWeight: "600" as const,
      color: "rgba(0,0,0,0.78)",
      fontFamily: FONTS.sans,
    },
    /** Card depth indicator (e.g. "2/4") */
    cardDepthIndicator: {
      fontSize: 11,
      fontWeight: "400" as const,
      color: "rgba(0,0,0,0.30)",
      fontFamily: FONTS.sans,
    },
    /** Card resolve checkmark */
    cardCheckIcon: {
      fontSize: 14,
      fontWeight: "500" as const,
      color: "rgba(0,0,0,0.40)",
      fontFamily: FONTS.sans,
    },
    /** Card inline text input (title editing) */
    cardTitleInput: {
      fontSize: 14,
      fontWeight: "600" as const,
      color: "rgba(0,0,0,0.78)",
      fontFamily: FONTS.sans,
    },
    /** Card message input field */
    cardInput: {
      fontSize: 13,
      lineHeight: 18,
      color: "#000000",
      fontFamily: FONTS.sans,
    },
    /** Card send arrow */
    cardSendArrow: {
      color: "#FFFFFF",
      fontSize: 14,
      fontWeight: "700" as const,
      lineHeight: 16,
      fontFamily: FONTS.sans,
    },
    /** Search bar input */
    searchInput: {
      fontSize: 16,
      color: "#000000",
      fontFamily: FONTS.sans,
    },
    /** Search bar icon */
    searchIcon: {
      fontSize: 15,
      fontWeight: "600" as const,
      color: "rgba(0,0,0,0.20)",
      fontFamily: FONTS.sans,
    },
    /** Hover tray action label */
    hoverTrayAction: {
      fontSize: 12,
      fontWeight: "500" as const,
      color: "rgba(0,0,0,0.55)",
      fontFamily: FONTS.sans,
    },
    /** Breadcrumb — current node */
    breadcrumbCurrent: {
      fontSize: 12,
      fontWeight: "600" as const,
      color: "rgba(40,35,30,0.85)",
      fontFamily: FONTS.sans,
    },
    /** Breadcrumb — ancestor nodes */
    breadcrumbAncestor: {
      fontSize: 12,
      fontWeight: "400" as const,
      color: "rgba(40,35,30,0.50)",
      fontFamily: FONTS.sans,
    },
    /** Breadcrumb separator / ellipsis */
    breadcrumbSep: {
      fontSize: 11,
      fontWeight: "400" as const,
      color: "rgba(40,35,30,0.25)",
      fontFamily: FONTS.sans,
    },
    /** Header + button icons */
    plusIcon: {
      fontSize: 22,
      fontWeight: "300" as const,
      color: "rgba(0,0,0,0.45)",
      fontFamily: FONTS.sans,
    },
    /** Breadcrumb inline edit input */
    breadcrumbEditInput: {
      fontSize: 12,
      fontWeight: "600" as const,
      color: "rgba(40,35,30,0.85)",
      fontFamily: FONTS.sans,
    },

    // ── AgentMessage markdown renderer styles ──
    /** Markdown body / default prose */
    markdownBody: {
      fontSize: AGENT_FONT_SIZE,
      lineHeight: 17,
      color: "rgba(0,0,0,0.85)",
      fontFamily: FONTS.sans,
    },
    /** Inline code within prose */
    markdownCodeInline: {
      fontSize: AGENT_FONT_SIZE,
      fontWeight: "500" as const,
      color: "rgba(0,0,0,0.85)",
      fontFamily: FONTS.sans,
    },
    /** Fenced / block code in markdown (fallback when no custom renderer) */
    markdownCodeBlock: {
      fontSize: AGENT_FONT_SIZE,
      color: "rgba(0,0,0,0.65)",
      lineHeight: 20,
      fontFamily: FONTS.mono,
    },
    /** Paragraph, bullet/ordered list items, blockquote */
    markdownParagraph: {
      fontSize: AGENT_FONT_SIZE,
      lineHeight: 17,
      fontFamily: FONTS.sans,
    },
    markdownHeading1: {
      fontSize: AGENT_FONT_SIZE + 3,
      fontWeight: "700" as const,
      lineHeight: 22,
      color: "rgba(0,0,0,0.85)",
      fontFamily: FONTS.sans,
    },
    markdownHeading2: {
      fontSize: AGENT_FONT_SIZE + 2,
      fontWeight: "700" as const,
      lineHeight: 20,
      color: "rgba(0,0,0,0.85)",
      fontFamily: FONTS.sans,
    },
    markdownHeading3: {
      fontSize: AGENT_FONT_SIZE + 1,
      fontWeight: "600" as const,
      lineHeight: 19,
      color: "rgba(0,0,0,0.85)",
      fontFamily: FONTS.sans,
    },
    /** Whisper footnote (trace summary below prose) */
    whisper: {
      fontSize: AGENT_FONT_SIZE - 2,
      lineHeight: 16,
      fontWeight: "400" as const,
      color: "rgba(0,0,0,0.28)",
      fontFamily: FONTS.mono,
    },

    // ── Figure card styles ──
    /** Figure icon */
    figureIcon: {
      fontSize: AGENT_FONT_SIZE - 1,
      color: "rgba(0,0,0,0.35)",
      fontFamily: FONTS.sans,
    },
    /** Figure title (filename, command, description) */
    figureTitle: {
      fontSize: AGENT_FONT_SIZE,
      fontWeight: "500" as const,
      color: "rgba(0,0,0,0.70)",
      fontFamily: FONTS.sans,
    },
    /** Figure status indicator */
    figureStatus: {
      fontSize: AGENT_FONT_SIZE - 2,
      fontFamily: FONTS.sans,
    },
    /** Figure subtitle (diff preview, output line) */
    figureSubtitle: {
      fontSize: AGENT_FONT_SIZE - 2,
      fontWeight: "400" as const,
      color: "rgba(0,0,0,0.35)",
      fontFamily: FONTS.mono,
    },
    /** Figure expanded drawer text */
    figureDrawerText: {
      fontSize: AGENT_FONT_SIZE - 2,
      lineHeight: 18,
      color: "rgba(0,0,0,0.50)",
      fontFamily: FONTS.mono,
    },

    // ── ChatCard secondary styles ──
    /** Edit label hint (currently unused, kept for future) */
    cardEditLabel: {
      fontSize: 11,
      fontWeight: "400" as const,
      color: "rgba(0,0,0,0.35)",
      fontFamily: FONTS.sans,
    },
    /** Promoted pill chevron */
    toolChevron: {
      fontSize: 14,
      fontWeight: "400" as const,
      fontFamily: FONTS.sans,
    },
    /** Expanded section label (uppercase heading) */
    toolSectionLabel: {
      fontSize: 9,
      fontWeight: "600" as const,
      color: "rgba(0,0,0,0.25)",
      fontFamily: FONTS.sans,
    },
    /** Pre-formatted text in expanded tool drawer */
    toolPreText: {
      fontSize: 11,
      fontFamily: FONTS.mono,
      color: "rgba(0,0,0,0.55)",
      lineHeight: 18,
    },
  },

  radii: {
    card: 16,
    userPill: 18,
    figure: 16,
    codeBlock: 12,
    input: 22,
    sendButton: 19,
  },

  spacing: {
    cardMaxWidth: 480,
    messagePaddingH: 20,
    messagePaddingV: 6,
  },

  glass: {
    bg: "rgba(255,255,255,0.82)",
    bgPressed: "rgba(255,255,255,0.88)",
    edgeBorder: 1.5,
    edgeColor: "rgba(255,255,255,0.4)",
    blur: "blur(20px) saturate(180%)",
    transition: "background-color 0.15s ease, transform 0.1s ease",
    shadow: {
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.1,
      shadowRadius: 12,
    },
  },

  // ── Status ──────────────────────────────────────────────────────────────
  // What the AGENT is doing. Thinking breathes (CSS animation).
  // All other statuses are static header tints.
  // ─────────────────────────────────────────────────────────────────────────
  status: {
    idle:          { tint: undefined as string | undefined, dot: "rgba(0,0,0,0.18)" },
    thinking:      { tint: "hsla(30, 40%, 55%, 0.00)",      dot: "rgba(0,0,0,0.18)" },
    "needs-input": { tint: "hsla(30, 28%, 52%, 0.10)",      dot: "rgba(0,0,0,0.18)" },
    failed:        { tint: "hsla(4, 40%, 52%, 0.14)",        dot: "hsl(4, 40%, 50%)" },
    resolved:      { tint: "hsla(145, 18%, 50%, 0.10)",      dot: "hsl(145, 22%, 46%)" },
  },

  // ── Priority ──────────────────────────────────────────────────────────
  // What matters to YOU. Amplifies the header tint when needs-input.
  //
  //   neither      clean white header, no tint
  //   important    cool blue wash — "this matters, take your time"
  //   urgent       warm amber wash — "this needs you soon"
  //   both         deep warm glow — "drop everything"
  //
  // Each has idle (background awareness) and needsInput (your turn) level.
  // ─────────────────────────────────────────────────────────────────────────
  priority: {
    important: {
      idle: "hsla(215, 26%, 50%, 0.12)",
      needsInput: "hsla(215, 32%, 44%, 0.24)",
    },
    urgent: {
      idle: "hsla(28, 48%, 50%, 0.14)",
      needsInput: "hsla(26, 55%, 46%, 0.30)",
    },
    both: {
      idle: "hsla(24, 52%, 48%, 0.18)",
      needsInput: "hsla(20, 60%, 42%, 0.36)",
    },
  },

  toolBar: {
    edit: {
      bg: "#1C1C1E",
      icon: "#FF9500",
      text: "#FF9500",
      chevron: "rgba(255,149,0,0.40)",
      shadow: "0 2px 8px rgba(0,0,0,0.20)",
    },
    bash: {
      bg: "#1C1C1E",
      icon: "#30D158",
      text: "rgba(255,255,255,0.85)",
      chevron: "rgba(255,255,255,0.30)",
      shadow: "0 2px 8px rgba(0,0,0,0.20)",
    },
    agent: {
      bg: "#FFFFFF",
      icon: "#007AFF",
      text: "rgba(0,0,0,0.55)",
      chevron: "rgba(0,0,0,0.30)",
      shadow: "0 2px 8px rgba(0,0,0,0.08), 0 0 0 0.5px rgba(0,0,0,0.04)",
    },
    mcp: {
      bg: "#FFFFFF",
      icon: "#AF52DE",
      text: "rgba(0,0,0,0.55)",
      chevron: "rgba(0,0,0,0.30)",
      shadow: "0 2px 8px rgba(0,0,0,0.08), 0 0 0 0.5px rgba(0,0,0,0.04)",
    },
  },

  timeOfDay: {
    morning:   { top: "hsl(25,30%,89%)",  base: "hsl(30,12%,92%)" },   // sunrise — coral-pink
    midday:    { top: "hsl(200,12%,91%)", base: "hsl(30,10%,93%)" },   // clear sky — warm neutral
    afternoon: { top: "hsl(36,26%,88%)",  base: "hsl(32,8%,93%)" },   // golden hour — amber
    evening:   { top: "hsl(20,22%,87%)",  base: "hsl(28,8%,92%)" },   // indoor warmth — ember
    night:     { top: "hsl(220,12%,87%)", base: "hsl(30,8%,91%)" },   // deep focus — warm base
  },

  layout: {
    headerH: 52,
    mobileBreakpoint: 640,
    gridGap: 32,
    gridPadding: 44,
    gridMaxWidth: 1200,
    messagePadH: 28,
    messagePadTop: 56,
    messagePadBottom: 120,
  },
} as const;
