import { View } from "react-native";

/** SVG paths — single source of truth for all Aria icons */
export const PATHS = {
  /** The Aria wave mark (from design/media/aria-eye.svg) */
  wave: "M515.89 276.276C501.145 277.413 479.301 280.131 467.39 282.31C309.377 311.213 183.198 430.204 144.996 586.336C136.862 619.578 134.062 643.989 134.001 682.177C133.944 717.907 135.566 734.268 141.473 757.542C148.732 786.148 156.782 798.395 170.82 802.195C178.178 804.187 183.375 803.746 189.527 800.607C196.008 797.301 201.09 791.986 212.886 776.177C227.929 756.018 240.289 741.894 257.255 725.479C315.531 669.096 388.006 631.774 467.39 617.268C494.28 612.354 507.728 611.245 540.39 611.245C563.518 611.245 574.394 611.674 585.39 613.023C635.355 619.15 677.404 631.534 720.39 652.779C779.333 681.91 827.82 722.473 867.894 776.177C879.69 791.986 884.772 797.301 891.253 800.607C897.405 803.746 902.602 804.187 909.96 802.195C923.998 798.395 932.048 786.148 939.307 757.542C945.121 734.635 946.787 717.974 946.796 682.677C946.804 650.881 945.534 635.465 940.779 609.677C930.626 554.61 909.776 503.038 879.234 457.446C811.582 356.455 706.346 292.243 585.39 278.152C572.606 276.663 526.882 275.429 515.89 276.276Z",
};

/** The Aria wave mark */
export function WaveIcon({ size = 18, color = "rgba(0,0,0,0.40)" }: { size?: number; color?: string }) {
  return (
    <View style={{ width: size, height: size }}>
      <div
        dangerouslySetInnerHTML={{
          __html: `<svg width="${size}" height="${size}" viewBox="0 0 1080 1080" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="${PATHS.wave}" fill="${color}"/></svg>`,
        }}
      />
    </View>
  );
}

/** Filled circle with plus — create new objective. Matches send button language. */
export function CreateIcon({ size = 32, bg = "rgba(0,0,0,0.10)", color = "#FFFFFF" }: { size?: number; bg?: string; color?: string }) {
  const cross = Math.round(size * 0.38);
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: bg, alignItems: "center", justifyContent: "center" }}>
      <div
        dangerouslySetInnerHTML={{
          __html: `<svg width="${cross}" height="${cross}" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg"><line x1="7" y1="2" x2="7" y2="12" stroke="${color}" stroke-width="2.5" stroke-linecap="round"/><line x1="2" y1="7" x2="12" y2="7" stroke="${color}" stroke-width="2.5" stroke-linecap="round"/></svg>`,
        }}
      />
    </View>
  );
}

/** Just a plus cross — for use inside GlassButton or other containers */
export function PlusIcon({ size = 14, color = "rgba(0,0,0,0.45)" }: { size?: number; color?: string }) {
  return (
    <View style={{ width: size, height: size }}>
      <div
        dangerouslySetInnerHTML={{
          __html: `<svg width="${size}" height="${size}" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg"><line x1="7" y1="1" x2="7" y2="13" stroke="${color}" stroke-width="1.5" stroke-linecap="round"/><line x1="1" y1="7" x2="13" y2="7" stroke="${color}" stroke-width="1.5" stroke-linecap="round"/></svg>`,
        }}
      />
    </View>
  );
}
