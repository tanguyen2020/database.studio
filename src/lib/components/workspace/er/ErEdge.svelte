<script lang="ts">
  // Relationship edge of the ER diagram. Draws an orthogonal route with rounded
  // corners (instead of a loose bezier) and ER "crow's foot" ends — MANY at the
  // FK column (child, source) and ONE at the referenced key (parent, target) — so
  // the cardinality reads without a label on every line. The label (columns +
  // N:1) only shows while the relationship is in focus: hovered, selected, or one
  // of its two tables is hovered. Everything else stays quiet.
  import { BaseEdge, EdgeLabel, Position, type EdgeProps } from '@xyflow/svelte'
  import type { ErHighlight } from '$lib/er/diagram'
  import { erRoute, manyEnd, oneEnd, type Side } from '$lib/er/edge-geometry'

  type Props = EdgeProps & {
    data?: { label?: string; pending?: boolean; hl?: ErHighlight; lane?: number }
  }
  let { id, source, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected = false, data }: Props = $props()

  const hl = $derived(data?.hl)
  const nodeFocus = $derived(hl?.node ?? null)
  const active = $derived(selected || hl?.edge === id || (nodeFocus !== null && (nodeFocus === source || nodeFocus === target)))
  // another table is in focus and this line is not one of its relationships
  const dimmed = $derived(!active && nodeFocus !== null)

  // The route + ends come from $lib/er/edge-geometry — the same code the SVG/PNG
  // export uses, so the exported picture matches the canvas. The line leaves the
  // table straight before turning (the crow's foot sits on a horizontal stub).
  // Several lines from one table get their own vertical lane (data.lane, see
  // laneOffsets) when the two tables face each other far enough apart.
  const side = (p: Position, fallback: Side): Side => (p === Position.Left ? -1 : p === Position.Right ? 1 : fallback)
  const sDir = $derived(side(sourcePosition, 1))
  const tDir = $derived(side(targetPosition, -1))
  const route = $derived.by(() => {
    const lane = data?.lane ?? 0
    const facing = sDir === 1 && tDir === -1 && targetX - sourceX > 60
    return erRoute(sourceX, sourceY, sDir, targetX, targetY, tDir, { centerX: lane && facing ? (sourceX + targetX) / 2 + lane : undefined })
  })
  const many = $derived(manyEnd(sourceX, sourceY, sDir))
  const one = $derived(oneEnd(targetX, targetY, tDir))
</script>

<g class="er-edge" class:active class:dimmed class:pending={data?.pending}>
  <BaseEdge {id} path={route.d} class="er-edge-path" interactionWidth={16} />
  <path d={many} class="er-edge-end" fill="none" />
  <path d={one} class="er-edge-end" fill="none" />
</g>

{#if data?.label && (active || data.pending)}
  <EdgeLabel x={route.labelX} y={route.labelY} class="er-edge-label{data.pending ? ' pending' : ''}" selectEdgeOnClick>
    {#if data.pending}<span class="er-edge-tag">Unsaved</span>{/if}{data.label}
  </EdgeLabel>
{/if}

<style>
  .er-edge {
    --er-stroke: var(--er-edge-color);
    transition: opacity 0.15s ease;
  }
  .er-edge.active {
    --er-stroke: var(--primary);
  }
  .er-edge.pending {
    --er-stroke: var(--success);
  }
  .er-edge.dimmed {
    opacity: 0.22;
  }
  .er-edge :global(.er-edge-path) {
    stroke: var(--er-stroke);
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
    transition: stroke 0.15s ease, stroke-width 0.15s ease;
  }
  .er-edge.active :global(.er-edge-path) {
    stroke-width: 2.2;
  }
  .er-edge.pending :global(.er-edge-path) {
    stroke-dasharray: 6 4;
    animation: er-dash 0.9s linear infinite;
  }
  .er-edge-end {
    stroke: var(--er-stroke);
    stroke-width: 1.6;
    stroke-linecap: round;
    transition: stroke 0.15s ease;
  }
  .er-edge.active .er-edge-end {
    stroke-width: 2;
  }
  :global(.svelte-flow__edge-label.er-edge-label) {
    font-size: var(--px-11);
    font-family: var(--font-mono);
    color: var(--text);
    background: var(--raised);
    border: var(--px-1) solid color-mix(in srgb, var(--primary) 45%, var(--border2));
    border-radius: var(--px-10);
    padding: var(--px-2) var(--px-8);
    box-shadow: var(--shadow-sm);
    white-space: nowrap;
    display: inline-flex;
    align-items: center;
    gap: var(--px-6);
  }
  :global(.svelte-flow__edge-label.er-edge-label.pending) {
    border-color: color-mix(in srgb, var(--success) 55%, var(--border2));
  }
  .er-edge-tag {
    font-family: var(--font-main);
    font-size: var(--px-10);
    font-weight: 700;
    color: var(--success);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  @keyframes er-dash {
    to {
      stroke-dashoffset: -10;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .er-edge.pending :global(.er-edge-path) {
      animation: none;
    }
  }
</style>
