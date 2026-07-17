import type {
  AppearanceDialDefinition,
  AppearanceDialMember,
  AppearanceDialSideOffset,
  AppearanceDialsManifest,
  AppearanceFollowerDriverRef,
} from "../appearanceDials.contracts";

export const APPEARANCE_RECIPE_DEPENDENCY_GRAPH_CONTRACT =
  "appearance-recipe-dependency-graph/v1" as const;

export type AppearanceRecipeDependencyNodeKind =
  | "control"
  | "unlock-gate"
  | "track"
  | "macro-engine"
  | "macro-corner"
  | "target-accumulator"
  | "target-clamp"
  | "follower"
  | "follower-channel"
  | "morph-output"
  | "node-matrix-output"
  | "pivot-output"
  | "joint-output"
  | "root-scale-output"
  | "grounding-output"
  | "root-transform-output"
  | "attachment-output";

export type AppearanceRecipeDependencyEdgeKind =
  | "owns-unlock-gate"
  | "owns-side-offset"
  | "evaluates-track"
  | "contributes-to-target"
  | "applies-exclusive-clamp"
  | "applies-sum-clamp"
  | "writes-morph"
  | "evaluates-macro-axis"
  | "evaluates-macro-corner"
  | "macro-contributes-to-target"
  | "drives-follower"
  | "owns-follower-channel"
  | "writes-follower-morph"
  | "evaluates-pivot"
  | "writes-node-matrix"
  | "moves-joint-rest"
  | "drives-root-scale"
  | "drives-grounding"
  | "composes-root-transform"
  | "defines-attachment-rest"
  | "propagates-parent-node"
  | "propagates-parent-bone";

export type AppearanceRecipeDependencyNode = {
  id: string;
  kind: AppearanceRecipeDependencyNodeKind;
};

export type AppearanceRecipeDependencyEdge = {
  from: string;
  to: string;
  kind: AppearanceRecipeDependencyEdgeKind;
};

export type AppearanceRecipeDependencyComponent = {
  id: string;
  nodeIds: string[];
  controlIds: string[];
  outputIds: string[];
};

/**
 * Supplemental R2 planner graph derived only from the typed Appearance Dials
 * contract. It records logical/physical-snapshot coupling; it is not the later
 * GLB physical basis or final geometry dependency graph.
 */
export type AppearanceRecipeDependencyGraph = {
  contract: typeof APPEARANCE_RECIPE_DEPENDENCY_GRAPH_CONTRACT;
  nodes: AppearanceRecipeDependencyNode[];
  edges: AppearanceRecipeDependencyEdge[];
  components: AppearanceRecipeDependencyComponent[];
  componentIdByNode: Record<string, string>;
};

const compareText = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

function isOutputKind(kind: AppearanceRecipeDependencyNodeKind): boolean {
  return kind.endsWith("-output");
}

class MutableDependencyGraph {
  private readonly nodes = new Map<
    string,
    AppearanceRecipeDependencyNodeKind
  >();
  private readonly edges = new Map<string, AppearanceRecipeDependencyEdge>();

  addNode(id: string, kind: AppearanceRecipeDependencyNodeKind): string {
    const existing = this.nodes.get(id);
    if (existing && existing !== kind) {
      throw new Error(
        `Appearance Recipe dependency node ${id} changed kind from ${existing} to ${kind}`,
      );
    }
    this.nodes.set(id, kind);
    return id;
  }

  addEdge(from: string, to: string, kind: AppearanceRecipeDependencyEdgeKind) {
    if (!this.nodes.has(from) || !this.nodes.has(to)) {
      throw new Error(
        `Appearance Recipe dependency edge ${kind} has an unknown endpoint`,
      );
    }
    const key = `${from}\u0000${to}\u0000${kind}`;
    this.edges.set(key, { from, to, kind });
  }

  import(graph: AppearanceRecipeDependencyGraph) {
    for (const node of graph.nodes) this.addNode(node.id, node.kind);
    for (const edge of graph.edges) this.addEdge(edge.from, edge.to, edge.kind);
  }

  finish(): AppearanceRecipeDependencyGraph {
    const nodes = [...this.nodes]
      .sort(([left], [right]) => compareText(left, right))
      .map(([id, kind]) => ({ id, kind }));
    const edges = [...this.edges.values()].sort((left, right) =>
      compareText(
        `${left.from}\u0000${left.to}\u0000${left.kind}`,
        `${right.from}\u0000${right.to}\u0000${right.kind}`,
      ),
    );

    const parent = new Map(nodes.map((node) => [node.id, node.id]));
    const find = (id: string): string => {
      const current = parent.get(id);
      if (!current) throw new Error(`missing dependency node ${id}`);
      if (current === id) return id;
      const root = find(current);
      parent.set(id, root);
      return root;
    };
    const union = (left: string, right: string) => {
      const leftRoot = find(left);
      const rightRoot = find(right);
      if (leftRoot === rightRoot) return;
      if (compareText(leftRoot, rightRoot) <= 0)
        parent.set(rightRoot, leftRoot);
      else parent.set(leftRoot, rightRoot);
    };
    for (const edge of edges) union(edge.from, edge.to);

    const byRoot = new Map<string, string[]>();
    for (const node of nodes) {
      const root = find(node.id);
      const members = byRoot.get(root) ?? [];
      members.push(node.id);
      byRoot.set(root, members);
    }
    const nodeKinds = new Map(nodes.map((node) => [node.id, node.kind]));
    const components = [...byRoot.values()]
      .map((nodeIds) => nodeIds.sort(compareText))
      .sort((left, right) => compareText(left[0] ?? "", right[0] ?? ""))
      .map((nodeIds, index) => ({
        id: `component:${index.toString().padStart(4, "0")}`,
        nodeIds,
        controlIds: nodeIds.filter((id) => nodeKinds.get(id) === "control"),
        outputIds: nodeIds.filter((id) => isOutputKind(nodeKinds.get(id)!)),
      }));
    const componentIdByNode: Record<string, string> = {};
    for (const component of components) {
      for (const nodeId of component.nodeIds) {
        componentIdByNode[nodeId] = component.id;
      }
    }
    return {
      contract: APPEARANCE_RECIPE_DEPENDENCY_GRAPH_CONTRACT,
      nodes,
      edges,
      components,
      componentIdByNode,
    };
  }
}

const controlNode = (id: string) => `control:${id}`;
const unlockNode = (id: string) => `unlock:${id}`;
const targetAccumulatorNode = (id: string) => `target:${id}:accumulator`;
const targetClampNode = (id: string) => `target:${id}:clamp`;
const morphOutputNode = (node: string, morph: string) =>
  `output:morph:${node}:${morph}`;
const nodeMatrixOutputNode = (node: string) => `output:node-matrix:${node}`;
const pivotOutputNode = (node: string) => `output:pivot:${node}`;
const jointOutputNode = (bone: string) => `output:joint:${bone}`;

function macroComponentsKey(
  components: Partial<Record<string, string>>,
): string {
  return Object.entries(components)
    .sort(([left], [right]) => compareText(left, right))
    .map(([axis, component]) => `${axis}:${component}`)
    .join("|");
}

function requireTarget(manifest: AppearanceDialsManifest, targetId: string) {
  if (!manifest.targets[targetId]) {
    throw new Error(
      `Appearance Recipe dependency references target ${targetId}`,
    );
  }
}

function addTrackMembers(
  graph: MutableDependencyGraph,
  manifest: AppearanceDialsManifest,
  ownerId: string,
  members: AppearanceDialMember[],
) {
  members.forEach((member, index) => {
    requireTarget(manifest, member.target);
    const track = graph.addNode(
      `track:${ownerId}:${member.target}:${index}`,
      "track",
    );
    graph.addEdge(controlNode(ownerId), track, "evaluates-track");
    graph.addEdge(
      track,
      targetAccumulatorNode(member.target),
      "contributes-to-target",
    );
  });
}

function addSideOffset(
  graph: MutableDependencyGraph,
  manifest: AppearanceDialsManifest,
  owner: AppearanceDialDefinition,
  side: AppearanceDialSideOffset,
) {
  graph.addNode(controlNode(side.id), "control");
  graph.addEdge(
    controlNode(owner.id),
    controlNode(side.id),
    "owns-side-offset",
  );
  graph.addEdge(unlockNode(owner.id), controlNode(side.id), "owns-side-offset");
  addTrackMembers(graph, manifest, side.id, side.members);
}

function followerDriverNode(
  manifest: AppearanceDialsManifest,
  controls: Set<string>,
  driver: AppearanceFollowerDriverRef,
): string {
  if (driver.kind === "dial") {
    if (!controls.has(driver.id)) {
      throw new Error(
        `Appearance Recipe follower references control ${driver.id}`,
      );
    }
    return controlNode(driver.id);
  }
  requireTarget(manifest, driver.id);
  return targetClampNode(driver.id);
}

/** Build the deterministic supplemental dependency graph for one manifest. */
export function buildAppearanceRecipeDependencyGraph(
  manifest: AppearanceDialsManifest,
): AppearanceRecipeDependencyGraph {
  const graph = new MutableDependencyGraph();
  const controls = new Set<string>();
  const addControl = (id: string) => {
    if (controls.has(id)) {
      throw new Error(`Appearance Recipe declares duplicate control ${id}`);
    }
    controls.add(id);
    graph.addNode(controlNode(id), "control");
  };

  for (const targetId of Object.keys(manifest.targets).sort(compareText)) {
    const target = manifest.targets[targetId]!;
    const accumulator = graph.addNode(
      targetAccumulatorNode(targetId),
      "target-accumulator",
    );
    const clamp = graph.addNode(targetClampNode(targetId), "target-clamp");
    graph.addEdge(
      accumulator,
      clamp,
      target.combine === "sum-clamp"
        ? "applies-sum-clamp"
        : "applies-exclusive-clamp",
    );
    for (const binding of [...target.bindings].sort((left, right) =>
      compareText(
        `${left.node}\u0000${left.morph}`,
        `${right.node}\u0000${right.morph}`,
      ),
    )) {
      if (!manifest.nodes[binding.node]) {
        throw new Error(
          `Appearance Recipe target ${targetId} references node ${binding.node}`,
        );
      }
      const output = graph.addNode(
        morphOutputNode(binding.node, binding.morph),
        "morph-output",
      );
      graph.addEdge(clamp, output, "writes-morph");
    }
  }

  const sortedDials = [...manifest.dials].sort((left, right) =>
    compareText(left.id, right.id),
  );
  for (const dial of sortedDials) {
    addControl(dial.id);
    if (dial.symmetry?.mode === "linked-with-offsets") {
      graph.addNode(unlockNode(dial.id), "unlock-gate");
      graph.addEdge(
        controlNode(dial.id),
        unlockNode(dial.id),
        "owns-unlock-gate",
      );
      addControl(dial.symmetry.left.id);
      addSideOffset(graph, manifest, dial, dial.symmetry.left);
      addControl(dial.symmetry.right.id);
      addSideOffset(graph, manifest, dial, dial.symmetry.right);
    }
    if (dial.kind === "tracks") {
      addTrackMembers(graph, manifest, dial.id, dial.members ?? []);
    }
  }

  if (manifest.macroEngine) {
    const macroEngine = graph.addNode("macro:engine", "macro-engine");
    const macroDials = sortedDials.filter((dial) => dial.kind === "macro-axis");
    for (const dial of macroDials) {
      const axisTrack = graph.addNode(`track:macro-axis:${dial.id}`, "track");
      graph.addEdge(controlNode(dial.id), axisTrack, "evaluates-track");
      graph.addEdge(axisTrack, macroEngine, "evaluates-macro-axis");
    }
    const corners = [...manifest.macroEngine.corners].sort((left, right) =>
      compareText(
        `${left.target}\u0000${left.family}\u0000${macroComponentsKey(left.comps)}`,
        `${right.target}\u0000${right.family}\u0000${macroComponentsKey(right.comps)}`,
      ),
    );
    corners.forEach((corner, index) => {
      requireTarget(manifest, corner.target);
      const cornerNode = graph.addNode(
        `macro:corner:${corner.target}:${index}`,
        "macro-corner",
      );
      graph.addEdge(macroEngine, cornerNode, "evaluates-macro-corner");
      graph.addEdge(
        cornerNode,
        targetAccumulatorNode(corner.target),
        "macro-contributes-to-target",
      );
    });
  }

  const variableBones = new Set<string>();
  for (const targetId of Object.keys(manifest.jointFollow?.deltas ?? {}).sort(
    compareText,
  )) {
    requireTarget(manifest, targetId);
    const perBone = manifest.jointFollow!.deltas[targetId]!;
    for (const bone of Object.keys(perBone).sort(compareText)) {
      variableBones.add(bone);
      const output = graph.addNode(jointOutputNode(bone), "joint-output");
      graph.addEdge(targetClampNode(targetId), output, "moves-joint-rest");
    }
  }

  const rootScale = "output:root-scale";
  const grounding = "output:grounding";
  const rootTransform = "output:root-transform";
  const rootDials = sortedDials.filter((dial) => dial.kind === "root-scale");
  const groundingTargets = Object.keys(manifest.targets)
    .filter((targetId) => manifest.targets[targetId]!.soleDeltaY !== undefined)
    .sort(compareText);
  if (rootDials.length > 0 || groundingTargets.length > 0) {
    graph.addNode(rootTransform, "root-transform-output");
  }
  if (rootDials.length > 0) {
    graph.addNode(rootScale, "root-scale-output");
    graph.addEdge(rootScale, rootTransform, "composes-root-transform");
    for (const dial of rootDials) {
      graph.addEdge(controlNode(dial.id), rootScale, "drives-root-scale");
    }
  }
  if (groundingTargets.length > 0) {
    graph.addNode(grounding, "grounding-output");
    graph.addEdge(grounding, rootTransform, "composes-root-transform");
    for (const targetId of groundingTargets) {
      graph.addEdge(targetClampNode(targetId), grounding, "drives-grounding");
    }
  }

  for (const nodeId of Object.keys(manifest.nodes).sort(compareText)) {
    const parent = manifest.nodes[nodeId]!.parent;
    if (parent?.kind === "node" && !manifest.nodes[parent.id]) {
      throw new Error(
        `Appearance Recipe node ${nodeId} references parent ${parent.id}`,
      );
    }
    graph.addNode(nodeMatrixOutputNode(nodeId), "node-matrix-output");
    if (manifest.nodes[nodeId]!.role === "attachment-anchor") {
      const attachment = graph.addNode(
        `output:attachment:${nodeId}`,
        "attachment-output",
      );
      graph.addEdge(
        nodeMatrixOutputNode(nodeId),
        attachment,
        "defines-attachment-rest",
      );
    }
  }

  const directVariableNodes = new Set<string>();
  for (const followerId of Object.keys(manifest.followers).sort(compareText)) {
    const follower = manifest.followers[followerId]!;
    const followerNode = graph.addNode(`follower:${followerId}`, "follower");
    const drivers = [...follower.drivers].sort((left, right) =>
      compareText(
        `${left.driver.kind}:${left.driver.id}`,
        `${right.driver.kind}:${right.driver.id}`,
      ),
    );
    for (const driver of drivers) {
      graph.addEdge(
        followerDriverNode(manifest, controls, driver.driver),
        followerNode,
        "drives-follower",
      );
      for (const channel of [...driver.channels].sort((left, right) =>
        compareText(left.id, right.id),
      )) {
        if (!manifest.nodes[channel.node]) {
          throw new Error(
            `Appearance Recipe follower ${followerId} references node ${channel.node}`,
          );
        }
        const channelNode = graph.addNode(
          `follower-channel:${followerId}:${channel.id}`,
          "follower-channel",
        );
        graph.addEdge(followerNode, channelNode, "owns-follower-channel");
        if (channel.kind === "morph-weight") {
          const output = graph.addNode(
            morphOutputNode(channel.node, channel.morph),
            "morph-output",
          );
          graph.addEdge(channelNode, output, "writes-follower-morph");
        } else {
          directVariableNodes.add(channel.node);
          const pivot = graph.addNode(
            pivotOutputNode(channel.node),
            "pivot-output",
          );
          graph.addEdge(channelNode, pivot, "evaluates-pivot");
          graph.addEdge(
            pivot,
            nodeMatrixOutputNode(channel.node),
            "writes-node-matrix",
          );
        }
      }
    }
  }

  // Parent transforms couple controls only when the typed manifest proves that
  // the parent is variable. Constant shared parents must not merge components.
  const variableNodes = new Set(directVariableNodes);
  let changed = true;
  while (changed) {
    changed = false;
    for (const nodeId of Object.keys(manifest.nodes).sort(compareText)) {
      if (variableNodes.has(nodeId)) continue;
      const parent = manifest.nodes[nodeId]!.parent;
      const variableParent =
        parent?.kind === "node"
          ? variableNodes.has(parent.id)
          : parent?.kind === "bone"
            ? variableBones.has(parent.name)
            : false;
      if (variableParent) {
        variableNodes.add(nodeId);
        changed = true;
      }
    }
  }
  for (const nodeId of Object.keys(manifest.nodes).sort(compareText)) {
    const parent = manifest.nodes[nodeId]!.parent;
    if (parent?.kind === "node" && variableNodes.has(parent.id)) {
      graph.addEdge(
        nodeMatrixOutputNode(parent.id),
        nodeMatrixOutputNode(nodeId),
        "propagates-parent-node",
      );
    } else if (parent?.kind === "bone" && variableBones.has(parent.name)) {
      graph.addEdge(
        jointOutputNode(parent.name),
        nodeMatrixOutputNode(nodeId),
        "propagates-parent-bone",
      );
    }
  }

  return graph.finish();
}

/**
 * Union old and new graphs before component closure. Stable controls/outputs
 * therefore reveal coupling introduced by either version instead of allowing
 * the planner to solve each version's smaller components independently.
 */
export function unionAppearanceRecipeDependencyGraphs(
  oldGraph: AppearanceRecipeDependencyGraph,
  newGraph: AppearanceRecipeDependencyGraph,
): AppearanceRecipeDependencyGraph {
  const graph = new MutableDependencyGraph();
  graph.import(oldGraph);
  graph.import(newGraph);
  return graph.finish();
}
