import { useRef, useEffect } from "react";
import { View, Text, Pressable, ScrollView, StyleSheet, Platform } from "react-native";
import { GlassButton } from "./Glass";
import { PlusIcon } from "./Icons";
import { theme } from "../constants/theme";
import type { ObjectiveNode } from "../hooks/adapters";

interface ProjectsStripProps {
  projects: ObjectiveNode[];
  onNavigate?: (id: string) => void;
  onCreateChild?: (parentId: string) => void;
  onEdit?: (id: string) => void;
  headerColor?: string;
  /** Dynamic time-of-day color for project card titles */
  titleColor?: string;
}

function ProjectCard({ project, onNavigate, onCreateChild, onEdit, titleColor }: {
  project: ObjectiveNode;
  onNavigate?: () => void;
  onCreateChild?: () => void;
  onEdit?: () => void;
  titleColor?: string;
}) {
  return (
    <Pressable
      onPress={onNavigate}
      style={({ pressed }) => [
        styles.card,
        pressed && { opacity: 0.85 },
      ]}
    >
      {/* Body — title + description at top, buttons at bottom */}
      <View style={styles.cardBody}>
        <View style={styles.cardContent}>
          <Text style={[styles.cardTitle, titleColor ? { color: titleColor } : undefined]}>{project.name}</Text>
          <Text style={styles.cardDescription}>{project.description || "No description"}</Text>
        </View>
        <View style={styles.actionButtons}>
          <GlassButton size={38} onPress={(e: any) => {
            e?.stopPropagation?.();
            if (project.id) console.log("resolve", project.id);
          }}>
            <Text style={styles.actionIcon}>{"\u2713"}</Text>
          </GlassButton>
          <GlassButton size={38} onPress={(e: any) => {
            e?.stopPropagation?.();
            onEdit?.();
          }}>
            <Text style={styles.actionIcon}>{"\u270E"}</Text>
          </GlassButton>
          <GlassButton size={38} onPress={(e: any) => {
            e?.stopPropagation?.();
            onCreateChild?.();
          }}>
            <PlusIcon size={16} color="rgba(0,0,0,0.45)" />
          </GlassButton>
        </View>
      </View>

      {/* Footer */}
      <View style={styles.cardFooter} />
    </Pressable>
  );
}

export function ProjectsStrip({ projects, onNavigate, onCreateChild, onEdit, headerColor, titleColor }: ProjectsStripProps) {
  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    if (Platform.OS !== "web" || !scrollRef.current) return;
    const outer = (scrollRef.current as unknown as { getScrollableNode?: () => HTMLElement })?.getScrollableNode?.()
      ?? (scrollRef.current as unknown as HTMLElement);
    if (!outer) return;
    const el = (outer.querySelector?.("[style*='overflow']") as HTMLElement) ?? outer;
    const handler = (e: WheelEvent) => {
      const dx = Math.abs(e.deltaX);
      const dy = Math.abs(e.deltaY);
      if (dx > dy && dx > 3) {
        e.preventDefault();
        el.scrollLeft += e.deltaX;
      }
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, []);

  if (projects.length === 0) return null;

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <Text style={[styles.sectionHeader, headerColor ? { color: headerColor } : undefined]}>Projects</Text>
      </View>
      <ScrollView
        ref={scrollRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
        style={styles.scroll}
      >
        {projects.map((project) => (
          <View key={project.id} style={styles.cardWrapper}>
            <ProjectCard
              project={project}
              onNavigate={onNavigate ? () => onNavigate(project.id) : undefined}
              onCreateChild={onCreateChild ? () => onCreateChild(project.id) : undefined}
              onEdit={onEdit ? () => onEdit(project.id) : undefined}
              titleColor={titleColor}
            />
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: "100%",
    paddingTop: 48,
    ...(Platform.OS === "web"
      ? { marginLeft: "auto", marginRight: "auto", overflow: "hidden" }
      : {}),
  } as any,
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: theme.layout.gridPadding,
    marginBottom: 24,
    maxWidth: theme.layout.gridMaxWidth,
    ...(Platform.OS === "web"
      ? { marginLeft: "auto", marginRight: "auto", width: "100%" }
      : {}),
  } as any,
  sectionHeader: {
    fontSize: 34,
    fontWeight: "700" as const,
    color: "rgba(22,18,14,0.65)",
    fontFamily: theme.fonts.sans,
    letterSpacing: -0.3,
  },
  scroll: {
    ...(Platform.OS === "web"
      ? { overflowX: "auto", overflowY: "hidden", overscrollBehaviorX: "contain" }
      : {}),
  } as any,
  scrollContent: {
    gap: theme.layout.gridGap,
    ...(Platform.OS === "web"
      ? {
          display: "flex",
          flexDirection: "row",
          flexWrap: "nowrap",
          paddingLeft: `max(${theme.layout.gridPadding}px, calc((100vw - ${theme.layout.gridMaxWidth}px) / 2 + ${theme.layout.gridPadding}px))`,
          paddingRight: theme.layout.gridPadding,
          paddingBottom: 8,
        }
      : { paddingHorizontal: theme.layout.gridPadding, flexDirection: "row" }),
  } as any,
  cardWrapper: {
    ...(Platform.OS === "web"
      ? {
          flexShrink: 0,
          width: "calc(50vw - 56px)",
          minWidth: 320,
          maxWidth: 560,
        }
      : {}),
  } as any,

  // ── Card ──
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: 20,
    overflow: "hidden",
    minHeight: 300,
    ...(Platform.OS === "web"
      ? {
          cursor: "pointer",
          transition: "opacity 150ms ease",
          display: "flex",
          flexDirection: "column",
          width: "100%",
          height: "100%",
        }
      : {}),
  } as any,
  cardBody: {
    flex: 1,
    paddingHorizontal: 28,
    paddingTop: 28,
    paddingBottom: 20,
    justifyContent: "space-between",
    ...(Platform.OS === "web"
      ? { display: "flex", flexDirection: "column" }
      : {}),
  } as any,
  cardContent: {
    gap: 12,
  },
  cardTitle: {
    fontSize: 38,
    fontWeight: "700" as const,
    color: "rgba(22,18,14,0.78)",
    fontFamily: theme.fonts.sans,
    letterSpacing: -0.5,
  },
  cardDescription: {
    fontSize: 16,
    fontWeight: "400" as const,
    lineHeight: 24,
    color: "rgba(22,18,14,0.65)",
    fontFamily: theme.fonts.sans,
  },
  actionButtons: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginTop: 4,
  },
  actionIcon: {
    fontSize: 17,
    fontWeight: "500" as const,
    color: "rgba(0,0,0,0.40)",
    fontFamily: theme.fonts.sans,
  },

  // ── Footer ──
  cardFooter: {
    height: 48,
    backgroundColor: "rgba(255,255,255,0.95)",
    borderTopWidth: 1,
    borderTopColor: "rgba(0,0,0,0.04)",
  },
});
