/**
 * Usage donut rings for the header.
 * Outer ring = 7-day weekly utilization
 * Inner ring = 5-hour session utilization
 * Polls /api/usage every 60s.
 */

import React, { useEffect, useState, useCallback } from "react";
import { View, Text, Platform } from "react-native";
import { theme } from "../constants/theme";

interface UsageBucket {
  utilization: number;
  resets_at: string;
}

interface UsageData {
  five_hour: UsageBucket | null;
  seven_day: UsageBucket | null;
  cached_at: number;
}

const POLL_INTERVAL = 60_000; // 60s

// ── Ring SVG ─────────────────────────────────────────────────────

function Ring({
  radius,
  stroke,
  progress,
  color,
  trackColor,
}: {
  radius: number;
  stroke: number;
  progress: number; // 0–100
  color: string;
  trackColor: string;
}) {
  const normalizedRadius = radius - stroke / 2;
  const circumference = 2 * Math.PI * normalizedRadius;
  const offset = circumference - (Math.min(progress, 100) / 100) * circumference;

  return (
    <>
      {/* Track */}
      <circle
        cx={radius}
        cy={radius}
        r={normalizedRadius}
        fill="none"
        stroke={trackColor}
        strokeWidth={stroke}
      />
      {/* Fill */}
      <circle
        cx={radius}
        cy={radius}
        r={normalizedRadius}
        fill="none"
        stroke={color}
        strokeWidth={stroke}
        strokeDasharray={`${circumference} ${circumference}`}
        strokeDashoffset={offset}
        strokeLinecap="round"
        transform={`rotate(-90 ${radius} ${radius})`}
        style={{ transition: "stroke-dashoffset 1s ease, stroke 0.5s ease" } as any}
      />
    </>
  );
}

// ── Color based on utilization ───────────────────────────────────

function ringColor(pct: number): string {
  if (pct < 50) return "rgba(40,35,30,0.30)";      // calm — matches clock color
  if (pct < 75) return "rgba(180,140,40,0.55)";     // warming — amber
  return "rgba(200,60,40,0.60)";                     // hot — red
}

// ── Format reset time ────────────────────────────────────────────

function formatReset(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = d.getTime() - now.getTime();
  if (diffMs < 0) return "now";
  const hours = Math.floor(diffMs / 3_600_000);
  const mins = Math.floor((diffMs % 3_600_000) / 60_000);
  if (hours > 24) {
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
  }
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

// ── Component ────────────────────────────────────────────────────

export function UsageRings() {
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [hovered, setHovered] = useState(false);

  const fetchUsage = useCallback(async () => {
    try {
      const res = await fetch("/api/usage");
      if (res.ok) {
        const data = await res.json();
        setUsage(data.usage ?? data);
      }
    } catch {
      // silent — rings just won't show
    }
  }, []);

  useEffect(() => {
    fetchUsage();
    const id = setInterval(fetchUsage, POLL_INTERVAL);
    return () => clearInterval(id);
  }, [fetchUsage]);

  if (!usage || (!usage.five_hour && !usage.seven_day)) return null;

  const session = usage.five_hour?.utilization ?? 0;
  const weekly = usage.seven_day?.utilization ?? 0;

  const size = 28;
  const outerR = size / 2;       // 14
  const outerStroke = 2.5;
  const innerR = 8;
  const innerStroke = 2.5;
  const innerOffset = outerR - innerR; // center the inner ring

  return (
    <View
      style={{ position: "relative" } as any}
      {...(Platform.OS === "web"
        ? {
            onMouseEnter: () => setHovered(true),
            onMouseLeave: () => setHovered(false),
          }
        : {})}
    >
      {/* Rings */}
      <View style={{ width: size, height: size }}>
        {Platform.OS === "web" && (
          <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
            {/* Outer ring — weekly */}
            <Ring
              radius={outerR}
              stroke={outerStroke}
              progress={weekly}
              color={ringColor(weekly)}
              trackColor="rgba(40,35,30,0.08)"
            />
            {/* Inner ring — session */}
            <g transform={`translate(${innerOffset}, ${innerOffset})`}>
              <Ring
                radius={innerR}
                stroke={innerStroke}
                progress={session}
                color={ringColor(session)}
                trackColor="rgba(40,35,30,0.06)"
              />
            </g>
          </svg>
        )}
      </View>

      {/* Tooltip on hover */}
      {hovered && Platform.OS === "web" && (
        <View
          style={{
            position: "absolute",
            top: 44,
            right: 0,
            backgroundColor: "rgba(255,255,255,0.92)",
            backdropFilter: "blur(20px) saturate(180%)",
            WebkitBackdropFilter: "blur(20px) saturate(180%)",
            borderRadius: 12,
            paddingVertical: 10,
            paddingHorizontal: 14,
            minWidth: 160,
            shadowColor: "#000",
            shadowOffset: { width: 0, height: 4 },
            shadowOpacity: 0.12,
            shadowRadius: 16,
            zIndex: 999,
            borderWidth: 1,
            borderColor: "rgba(255,255,255,0.5)",
          } as any}
        >
          <Text
            style={{
              fontSize: 10,
              fontWeight: "600" as const,
              color: "rgba(40,35,30,0.35)",
              fontFamily: theme.fonts.sans,
              letterSpacing: 0.5,
              textTransform: "uppercase",
              marginBottom: 8,
            }}
          >
            Claude Usage
          </Text>

          {/* Session row */}
          <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 6 } as any}>
            <View
              style={{
                width: 8,
                height: 8,
                borderRadius: 4,
                backgroundColor: ringColor(session),
                marginRight: 8,
              }}
            />
            <Text
              style={{
                fontSize: 12,
                fontWeight: "500" as const,
                color: "rgba(40,35,30,0.70)",
                fontFamily: theme.fonts.sans,
                flex: 1,
              }}
            >
              5h session
            </Text>
            <Text
              style={{
                fontSize: 12,
                fontWeight: "600" as const,
                color: "rgba(40,35,30,0.70)",
                fontFamily: theme.fonts.mono,
              }}
            >
              {Math.round(session)}%
            </Text>
          </View>

          {usage.five_hour?.resets_at && (
            <Text
              style={{
                fontSize: 10,
                color: "rgba(40,35,30,0.35)",
                fontFamily: theme.fonts.sans,
                marginBottom: 8,
                marginLeft: 16,
              }}
            >
              resets in {formatReset(usage.five_hour.resets_at)}
            </Text>
          )}

          {/* Weekly row */}
          <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 6 } as any}>
            <View
              style={{
                width: 8,
                height: 8,
                borderRadius: 4,
                backgroundColor: ringColor(weekly),
                marginRight: 8,
              }}
            />
            <Text
              style={{
                fontSize: 12,
                fontWeight: "500" as const,
                color: "rgba(40,35,30,0.70)",
                fontFamily: theme.fonts.sans,
                flex: 1,
              }}
            >
              7d weekly
            </Text>
            <Text
              style={{
                fontSize: 12,
                fontWeight: "600" as const,
                color: "rgba(40,35,30,0.70)",
                fontFamily: theme.fonts.mono,
              }}
            >
              {Math.round(weekly)}%
            </Text>
          </View>

          {usage.seven_day?.resets_at && (
            <Text
              style={{
                fontSize: 10,
                color: "rgba(40,35,30,0.35)",
                fontFamily: theme.fonts.sans,
                marginLeft: 16,
              }}
            >
              resets in {formatReset(usage.seven_day.resets_at)}
            </Text>
          )}
        </View>
      )}
    </View>
  );
}
