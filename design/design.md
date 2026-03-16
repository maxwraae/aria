# Aria Design Language

## The Feel

Aria is warm intelligence. Not cold precision, not clinical efficiency. The design conviction is that intelligence does not have to feel cold. Most AI interfaces lean into the clinical: dark backgrounds, sharp edges, monospace fonts, the aesthetic of a terminal dressed up. Aria goes the opposite direction. Equally smart, opposite temperature.

Think of someone who is ruthlessly intelligent but genuinely cares. Not Steve Jobs, whose genius came wrapped in cold precision. Closer to a person who walks into a room and you feel both welcomed and sharpened. Friendly, but never soft. Warm, but never vague.

Aria is also a name. Not "the Aria system" or "the Aria engine." Just Aria. She has a personality. She's musical (the name, by coincidence, means a melody for a single voice), she's fluid, she's welcoming, and she's paying attention.

## The Name

**Adaptive Recursive Intelligent Actions.** The acronym came first and the name emerged from it. The fact that "aria" also means melody, and that it's a person's name, was not planned. But it fits so well that it feels intentional. The musicality, the warmth, the sense of a single voice carrying something beautiful. The name earns itself in retrospect.

## The Icon

A wave. Not an eye, not a target, not a checkbox. A single continuous curve, like something rising to the surface. It has body. It feels welcoming and open, like a gesture of invitation. It sits comfortably as a favicon in the browser tab, as a small mark, as a large shape. It was designed by hand, one SVG path.

The wave connects to the broader language: fluid, flowing, surface, rising. Aria surfaces things. She brings what matters up to where you can see it.

Source file: `design/media/aria-eye.svg`

## The Sky

The background is the sky. Literally. The interface shifts color throughout the day, following the light outside. Sunrise coral in the morning, clear and cool at midday, golden in the afternoon, ember warmth in the evening, deep and quiet at night. Five periods, each with its own hue.

This was not about aesthetics. It was about presence. The sky is always there, always changing, never in the way. You don't stare at the sky, but you're aware of it. It tells you something about the world without demanding attention. The background does the same thing. It grounds you in time without showing you a clock.

The palette lives in the warm range, hsl(20-36), shifting between amber, coral, and cream. Even the cooler periods (midday, night) stay warm. The interface never goes cold.

## The Breathing

The background breathes. A continuous, slow oscillation in brightness, barely perceptible. This is the heartbeat. It makes the interface feel alive, like something is there even when nothing is happening.

When Aria is thinking, the breathing intensifies. Cards pulse with a warm glow that matches the time-of-day hue. When she finishes, the glow settles. The breathing is not a loading indicator. It is Aria being alive. A loading spinner says "wait." Breathing says "I'm here."

## The Glass

Interactive elements use glass morphism: translucent white with a blur behind them. Buttons, toolbars, the input bar. The glass sits on top of the sky, letting the warmth through. It catches light. It feels physical in the way that frosted glass on a warm day feels physical. You can almost sense the texture.

The glass connects to the surface metaphor. You're looking at a surface, and through it, at the sky. The interactive layer floats on top of the ambient layer. Two depths, one warm.

## The Palette

Everything derives from warmth. The base background is `hsl(30, 22%, 90%)`, a warm cream. Text is black at reduced opacity, never pure black on pure white. The whole interface breathes through the same tonal range.

**Time-of-day hues:**
- Morning (6-10): sunrise coral, `hsl(25, 30%)`
- Midday (10-15): clear with warmth, `hsl(200, 12%)`
- Afternoon (15-19): golden hour, `hsl(36, 26%)`
- Evening (19-22): ember glow, `hsl(20, 22%)`
- Night (22-6): deep and quiet, `hsl(220, 12%)`

**Status colors are quiet.** Thinking is a warm amber glow, not a flashing indicator. Failed is a soft red tint, not a screaming error. Resolved fades to near-transparency. The loudest thing in the interface is the content, never the chrome.

## Typography

Apple system fonts. Nothing custom, nothing decorative. The typeface should disappear. `-apple-system` on the Mac, the platform default everywhere else. The text is the content. The font is invisible.

Sizes are small and considered. Body text at 13px on desktop, stepping up to 16px on mobile for touch readability. Titles at 14px. Nothing shouts. The hierarchy comes from weight and opacity, not size.

## Shape

Rounded. Everything. Cards at 16px radius, input fields at 22px, buttons at 19px. No sharp corners anywhere. Sharp corners create tension. Rounded corners create comfort. The entire interface feels soft to the eye without being childish.

## What Aria Is Not

- **Not a terminal.** No dark backgrounds, no monospace aesthetic, no command-line feel.
- **Not cold.** No blue-white LED glow, no clinical precision, no sterile efficiency.
- **Not loud.** No bright status colors demanding attention, no toast notifications sliding in, no animation for the sake of animation.
- **Not a dashboard.** No grids of metrics, no progress bars, no KPI displays.
- **Not invisible.** Aria has presence. She's not trying to disappear. The breathing, the warmth, the shifting sky. She's there. You feel her.

## The Principle

Intelligence can be warm. That's the whole thing. Every design decision flows from this. When choosing between a cold option and a warm option, choose warm. When choosing between loud and quiet, choose quiet. When choosing between mechanical and alive, choose alive. Aria is the proof that you don't have to sacrifice warmth to be smart.
