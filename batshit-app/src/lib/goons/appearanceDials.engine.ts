import * as THREE from "three";
import {
  parseAppearanceDialsManifest,
  resolveAppearanceDialState,
  validateAppearanceRuntimeInventory,
  type AppearanceDialValueState,
  type AppearanceDialsManifest,
  type AppearanceRuntimeInventory,
  type ResolvedAppearanceDialState,
  type ValidatedAppearanceRuntimeInventory,
} from "./appearanceDials";
import { normalizeFaceMorphCollisionName } from "./appearanceDials.validation";
import {
  getCustomRuntimeNodeNameCandidates,
  resolveCustomNamedNode,
  sanitizeCustomRuntimeNodeName,
  type GoonCustomAvatarManifest,
} from "./customAvatar";
import { resolveCustomPerformanceRigManifest } from "./customPerformanceRig";
import { parseEyeAppearanceDefinition } from "./eyeAppearance";
import {
  APPEARANCE_RECIPE_PHYSICAL_BASIS_CONTRACT,
  evaluateAppearanceRecipePhysicalOutput,
  type AppearanceRecipePhysicalBasis,
} from "./recipe/appearanceRecipePhysicalEvaluator";

type RuntimeMorphBinding = {
  mesh: THREE.Mesh;
  index: number;
  morph: string;
};

type RuntimeBakedMesh = {
  mesh: THREE.Mesh;
  position: THREE.BufferAttribute;
  basePosition: Float32Array;
  bakedBasePosition: Float32Array;
};

type RuntimeBakedMorphBinding = {
  runtime: RuntimeBakedMesh;
  delta: Float32Array;
};

type RuntimeBone = {
  node: THREE.Object3D;
};

type RuntimeSkin = {
  mesh: THREE.SkinnedMesh;
  baseInverses: THREE.Matrix4[];
};

type RuntimeFollowerNode = {
  node: THREE.Object3D;
};

type HipsClipRemap = {
  node: THREE.Object3D;
  baseRest: THREE.Vector3;
  newRest: THREE.Vector3;
  ratio: number;
  lastOutput: THREE.Vector3 | null;
};

export type AppearanceDialsEngineOptions = {
  faceMeshes?: Iterable<THREE.Mesh>;
  initialValues?: unknown;
};

function morphRuntimeKey(runtimeId: string, index: number): string {
  return runtimeId + "\u0000" + index;
}

function lazyPositionDelta(delta: Float32Array) {
  return {
    length: delta.length,
    visit(visitor: (index: number, value: number) => void) {
      for (let index = 0; index < delta.length; index += 1) {
        visitor(index, delta[index] ?? 0);
      }
    },
  };
}

function readVec3Attribute(
  attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
): Float32Array {
  if (
    attribute instanceof THREE.BufferAttribute &&
    attribute.itemSize === 3 &&
    !attribute.normalized &&
    attribute.array instanceof Float32Array
  ) {
    return attribute.array.length === attribute.count * 3
      ? attribute.array
      : attribute.array.subarray(0, attribute.count * 3);
  }
  const values = new Float32Array(attribute.count * 3);
  for (let index = 0; index < attribute.count; index += 1) {
    const offset = index * 3;
    values[offset] = attribute.getX(index);
    values[offset + 1] = attribute.getY(index);
    values[offset + 2] = attribute.getZ(index);
  }
  return values;
}

function buildRuntimeInventory(
  root: THREE.Object3D,
  manifest: AppearanceDialsManifest,
  faceMeshes: Set<THREE.Mesh>,
): {
  inventory: AppearanceRuntimeInventory;
  nodesByRuntimeId: Map<string, THREE.Object3D>;
  morphBindings: Map<string, RuntimeMorphBinding>;
} {
  const nodesByRuntimeId = new Map<string, THREE.Object3D>();
  const morphBindings = new Map<string, RuntimeMorphBinding>();
  const nodes: AppearanceRuntimeInventory["nodes"] = [];
  const faceBindings: AppearanceRuntimeInventory["faceBindings"] = [];
  const mappedFaceMorphNames = new Set(manifest.mappedFaceMorphNames);
  const declaredNodeNames = new Set(
    Object.values(manifest.nodes).map((entry) => entry.node),
  );
  const selectedNodes: THREE.Object3D[] = [];

  root.traverse((node) => {
    if (
      declaredNodeNames.has(node.name) ||
      faceMeshes.has(node as THREE.Mesh)
    ) {
      selectedNodes.push(node);
    }
  });
  const selectedNodeSet = new Set(selectedNodes);

  for (const node of selectedNodes) {
    const runtimeId = node.uuid;
    nodesByRuntimeId.set(runtimeId, node);
    const mesh = node as THREE.Mesh;
    const isMesh = Boolean((mesh as { isMesh?: boolean }).isMesh);
    const dict = isMesh ? (mesh.morphTargetDictionary ?? {}) : {};
    const influences = isMesh ? mesh.morphTargetInfluences : undefined;
    const morphs = Object.entries(dict)
      .map(([name, index]) => ({
        name,
        index,
        initialWeight: Array.isArray(influences) ? (influences[index] ?? 0) : 0,
      }))
      .sort(
        (left, right) =>
          left.index - right.index || left.name.localeCompare(right.name),
      );
    for (const morph of morphs) {
      morphBindings.set(morphRuntimeKey(runtimeId, morph.index), {
        mesh,
        index: morph.index,
        morph: morph.name,
      });
      if (
        faceMeshes.has(mesh) &&
        mappedFaceMorphNames.has(normalizeFaceMorphCollisionName(morph.name))
      ) {
        faceBindings.push({ runtimeNodeId: runtimeId, morph: morph.name });
      }
    }
    nodes.push({
      runtimeId,
      node: node.name,
      kind: isMesh ? "mesh" : "anchor",
      ...(node.parent && selectedNodeSet.has(node.parent)
        ? { parentRuntimeId: node.parent.uuid }
        : {}),
      ...(node.parent && (node.parent as { isBone?: boolean }).isBone
        ? { parentBone: node.parent.name }
        : {}),
      localScale: [node.scale.x, node.scale.y, node.scale.z],
      morphs,
    });
  }

  return {
    inventory: { nodes, faceBindings },
    nodesByRuntimeId,
    morphBindings,
  };
}

/**
 * THREE.js application layer for the strict appearance-dials/v2 contract.
 * The pure parser/resolver owns semantics; this class owns exact runtime
 * inventory binding, rest capture, deterministic writes, and complete reset.
 */
export class AppearanceDialsEngineRuntime {
  readonly manifest: AppearanceDialsManifest;
  readonly ownedFaceMorphNames: Set<string>;

  private readonly root: THREE.Object3D;
  private readonly targetBindings = new Map<string, RuntimeMorphBinding[]>();
  private readonly retainedPhysicalBindings = new Map<
    string,
    RuntimeMorphBinding
  >();
  private readonly bakedTargetBindings = new Map<
    string,
    RuntimeBakedMorphBinding[]
  >();
  private readonly followerMorphBindings = new Map<
    string,
    RuntimeMorphBinding
  >();
  private readonly bakedFollowerMorphBindings = new Map<
    string,
    RuntimeBakedMorphBinding
  >();
  private readonly bakedMeshes = new Set<RuntimeBakedMesh>();
  private readonly followerNodes = new Map<string, RuntimeFollowerNode>();
  private readonly bones = new Map<string, RuntimeBone>();
  private readonly skins: RuntimeSkin[] = [];
  private readonly physicalNodes = new Map<string, THREE.Object3D>();
  private readonly physicalBasis: AppearanceRecipePhysicalBasis;
  private readonly rootBaseQuaternion: THREE.Quaternion;
  private hipsRemap: HipsClipRemap | null = null;
  private values: unknown;
  private state: ResolvedAppearanceDialState;

  constructor(
    root: THREE.Object3D,
    rawManifest: GoonCustomAvatarManifest,
    options: AppearanceDialsEngineOptions = {},
  ) {
    const manifest = parseAppearanceDialsManifest(rawManifest);
    if (!manifest) {
      throw new Error(
        "appearance-dials/v2 runtime requires avatar.json#appearanceDials",
      );
    }
    this.root = root;
    this.manifest = manifest;
    this.values = options.initialValues ?? null;
    this.rootBaseQuaternion = root.quaternion.clone();

    const faceMeshes = new Set(options.faceMeshes ?? []);
    const built = buildRuntimeInventory(root, manifest, faceMeshes);
    const validated = validateAppearanceRuntimeInventory(
      manifest,
      built.inventory,
    );

    const recipeRuntimeKeys = new Set<string>();
    for (const binding of validated.bindings) {
      if (
        manifest.targets[binding.target]?.runtimeRetention === "recipe-only"
      ) {
        recipeRuntimeKeys.add(
          morphRuntimeKey(binding.runtimeNodeId, binding.index),
        );
      }
    }
    for (const binding of validated.followerMorphBindings) {
      recipeRuntimeKeys.add(
        morphRuntimeKey(binding.runtimeNodeId, binding.index),
      );
    }
    const bakedByRuntimeKey = this.prepareRecipeBaking(
      built.morphBindings,
      recipeRuntimeKeys,
    );

    for (const binding of validated.bindings) {
      const key = morphRuntimeKey(binding.runtimeNodeId, binding.index);
      const runtime = built.morphBindings.get(key);
      if (!runtime) {
        throw new Error(
          `appearance target ${binding.target} lost its validated runtime binding`,
        );
      }
      const baked = bakedByRuntimeKey.get(key);
      if (baked) {
        const entries = this.bakedTargetBindings.get(binding.target) ?? [];
        entries.push(baked);
        this.bakedTargetBindings.set(binding.target, entries);
      } else {
        const entries = this.targetBindings.get(binding.target) ?? [];
        entries.push(runtime);
        this.targetBindings.set(binding.target, entries);
      }
    }
    for (const binding of validated.followerMorphBindings) {
      const key = morphRuntimeKey(binding.runtimeNodeId, binding.index);
      const runtime = built.morphBindings.get(key);
      if (!runtime) {
        throw new Error(
          `appearance follower ${binding.follower}/${binding.channel} lost its runtime binding`,
        );
      }
      const followerKey = binding.follower + "\u0000" + binding.channel;
      const baked = bakedByRuntimeKey.get(key);
      if (baked) {
        this.bakedFollowerMorphBindings.set(followerKey, baked);
      } else {
        this.followerMorphBindings.set(followerKey, runtime);
      }
    }
    for (const [
      manifestNodeId,
      runtimeId,
    ] of validated.runtimeNodeIdsByManifestNode) {
      const node = built.nodesByRuntimeId.get(runtimeId);
      if (!node) {
        throw new Error(
          `appearance node ${manifestNodeId} lost its validated runtime object`,
        );
      }
      this.followerNodes.set(manifestNodeId, {
        node,
      });
    }

    this.ownedFaceMorphNames = new Set<string>();
    for (const binding of [
      ...validated.bindings,
      ...validated.followerMorphBindings,
    ]) {
      this.ownedFaceMorphNames.add(
        normalizeFaceMorphCollisionName(binding.morph),
      );
    }

    this.captureRig();
    this.physicalBasis = this.capturePhysicalBasis(rawManifest, validated);
    this.state = resolveAppearanceDialState(manifest, this.values);
    this.applyResolvedState(this.state);
  }

  /**
   * Identity targets are authoring recipes, not live animation channels. Keep
   * their CPU deltas for dial edits, then remove them from the mesh morph
   * inventory before the renderer sees the geometry. This keeps WebGPU/WebGL
   * shaders proportional to the dynamic face/corrective set instead of the
   * full identity catalog.
   */
  private prepareRecipeBaking(
    morphBindings: Map<string, RuntimeMorphBinding>,
    recipeRuntimeKeys: Set<string>,
  ): Map<string, RuntimeBakedMorphBinding> {
    const recipeIndicesByMesh = new Map<THREE.Mesh, Set<number>>();
    for (const key of recipeRuntimeKeys) {
      const binding = morphBindings.get(key);
      if (!binding) continue;
      const indices =
        recipeIndicesByMesh.get(binding.mesh) ?? new Set<number>();
      indices.add(binding.index);
      recipeIndicesByMesh.set(binding.mesh, indices);
    }

    const bakedByRuntimeKey = new Map<string, RuntimeBakedMorphBinding>();
    for (const [mesh, recipeIndices] of recipeIndicesByMesh) {
      const geometry = mesh.geometry;
      const sourcePosition = geometry.getAttribute("position");
      if (!sourcePosition) {
        throw new Error(
          `appearance recipe mesh ${mesh.name || mesh.uuid} has no POSITION attribute`,
        );
      }
      const basePosition = readVec3Attribute(sourcePosition).slice();
      const position = new THREE.Float32BufferAttribute(
        basePosition.slice(),
        3,
      );
      position.setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute("position", position);
      const originalMorphPositions = geometry.morphAttributes.position ?? [];
      const originalInfluences = mesh.morphTargetInfluences ?? [];
      const originalDictionary = mesh.morphTargetDictionary ?? {};
      const retainedIndices = originalMorphPositions
        .map((_, index) => index)
        .filter((index) => !recipeIndices.has(index));
      const bakedMesh: RuntimeBakedMesh = {
        mesh,
        position,
        basePosition,
        bakedBasePosition: basePosition.slice(),
      };
      this.bakedMeshes.add(bakedMesh);

      for (const [key, binding] of morphBindings) {
        if (binding.mesh !== mesh || !recipeIndices.has(binding.index))
          continue;
        const morphPosition =
          geometry.morphAttributes.position?.[binding.index];
        if (!morphPosition) {
          throw new Error(
            `appearance recipe morph ${mesh.name || mesh.uuid}/${binding.morph} has no POSITION delta`,
          );
        }
        let delta = readVec3Attribute(morphPosition);
        if (!geometry.morphTargetsRelative) {
          delta = delta.slice();
          for (let index = 0; index < delta.length; index += 1) {
            delta[index] -= basePosition[index] ?? 0;
          }
        }
        bakedByRuntimeKey.set(key, { runtime: bakedMesh, delta });
      }

      const oldToNew = new Map(
        retainedIndices.map((oldIndex, newIndex) => [oldIndex, newIndex]),
      );
      for (const attributeName of ["position", "normal", "color"] as const) {
        const originalAttributes = geometry.morphAttributes[attributeName];
        if (!originalAttributes) {
          delete geometry.morphAttributes[attributeName];
          continue;
        }
        const retainedAttributes = retainedIndices.map(
          (index) => originalAttributes[index],
        );
        if (retainedAttributes.some((attribute) => !attribute)) {
          throw new Error(
            `appearance live morph ${mesh.name || mesh.uuid} has incomplete ${attributeName.toUpperCase()} payloads`,
          );
        }
        if (retainedAttributes.length > 0) {
          geometry.morphAttributes[attributeName] =
            retainedAttributes as THREE.BufferAttribute[];
        } else {
          // Three's WebGPU MorphNode treats an existing empty array as an
          // enabled morph channel. Delete zero-length inventories entirely.
          delete geometry.morphAttributes[attributeName];
        }
      }
      mesh.morphTargetDictionary = Object.fromEntries(
        Object.entries(originalDictionary)
          .filter(([, index]) => oldToNew.has(index))
          .map(([name, index]) => [name, oldToNew.get(index)!]),
      );
      mesh.morphTargetInfluences = retainedIndices.map(
        (index) => originalInfluences[index] ?? 0,
      );

      for (const binding of morphBindings.values()) {
        if (binding.mesh !== mesh || recipeIndices.has(binding.index)) continue;
        const newIndex = oldToNew.get(binding.index);
        if (newIndex === undefined) {
          throw new Error(
            `appearance live morph ${mesh.name || mesh.uuid}/${binding.morph} lost its index`,
          );
        }
        binding.index = newIndex;
      }
    }
    return bakedByRuntimeKey;
  }

  private captureRig() {
    this.root.updateMatrixWorld(true);
    this.root.traverse((node) => {
      if ((node as { isBone?: boolean }).isBone) {
        const entry: RuntimeBone = { node };
        this.bones.set(node.name, entry);
        this.bones.set(sanitizeCustomRuntimeNodeName(node.name), entry);
      }
      const skinned = node as THREE.SkinnedMesh;
      if (
        (skinned as { isSkinnedMesh?: boolean }).isSkinnedMesh &&
        skinned.skeleton
      ) {
        if (
          skinned.skeleton.bones.length !== skinned.skeleton.boneInverses.length
        ) {
          throw new Error(
            `appearance skin ${skinned.name || skinned.uuid} has mismatched joint and inverse-bind slots`,
          );
        }
        this.skins.push({
          mesh: skinned,
          baseInverses: skinned.skeleton.boneInverses.map((matrix) =>
            matrix.clone(),
          ),
        });
      }
    });

    const hipsName = this.manifest.jointFollow?.clipRemap?.hipsBone;
    const hips = hipsName ? this.resolveBone(hipsName) : null;
    if (hips) {
      this.hipsRemap = {
        node: hips,
        baseRest: hips.position.clone(),
        newRest: hips.position.clone(),
        ratio: 1,
        lastOutput: null,
      };
    }
  }

  private capturePhysicalBasis(
    rawManifest: GoonCustomAvatarManifest,
    validated: ValidatedAppearanceRuntimeInventory,
  ): AppearanceRecipePhysicalBasis {
    const baseMatrix = (node: THREE.Object3D) => {
      if (!node.matrixAutoUpdate) return node.matrix.toArray();
      return new THREE.Matrix4()
        .compose(node.position, node.quaternion, node.scale)
        .toArray();
    };
    const resolveExactRoleNode = (nodeName: string, context: string) => {
      const candidates = new Set(getCustomRuntimeNodeNameCandidates(nodeName));
      const matches: THREE.Object3D[] = [];
      this.root.traverse((node) => {
        if (candidates.has(node.name)) matches.push(node);
      });
      if (matches.length === 0) {
        throw new Error(
          `appearance ${context} points to missing node ${nodeName}`,
        );
      }
      if (matches.length !== 1) {
        throw new Error(
          `appearance ${context} is ambiguous for node ${nodeName}`,
        );
      }
      return matches[0]!;
    };

    const bakedByMeshId = new Map(
      [...this.bakedMeshes].map((runtime) => [runtime.mesh.uuid, runtime]),
    );
    const nodes: AppearanceRecipePhysicalBasis["nodes"] = [];
    const meshes: AppearanceRecipePhysicalBasis["meshes"] = [];
    const meshBasePositions = new Map<string, Float32Array>();
    this.root.traverse((node) => {
      if (node === this.root) return;
      this.physicalNodes.set(node.uuid, node);
      nodes.push({
        id: node.uuid,
        ...(node.parent && node.parent !== this.root
          ? { parentId: node.parent.uuid }
          : {}),
        baseLocalMatrix: baseMatrix(node),
      });
      const mesh = node as THREE.Mesh;
      if (!(mesh as { isMesh?: boolean }).isMesh) return;
      const position = mesh.geometry.getAttribute("position");
      if (!position) {
        throw new Error(
          `appearance physical mesh ${mesh.name || mesh.uuid} has no POSITION attribute`,
        );
      }
      const basePositions =
        bakedByMeshId.get(mesh.uuid)?.basePosition ??
        readVec3Attribute(position).slice();
      meshBasePositions.set(mesh.uuid, basePositions);
      meshes.push({
        id: mesh.uuid,
        nodeId: mesh.uuid,
        basePositions,
      });
    });

    const uniqueBones = [...this.physicalNodes.values()].filter(
      (node) => (node as { isBone?: boolean }).isBone,
    );

    const targetPositionBindings: AppearanceRecipePhysicalBasis["targetPositionBindings"] =
      [];
    for (const target of Object.keys(this.manifest.targets)) {
      for (const [index, binding] of (
        this.bakedTargetBindings.get(target) ?? []
      ).entries()) {
        targetPositionBindings.push({
          id: `target:${target}:${index}`,
          targetId: target,
          meshId: binding.runtime.mesh.uuid,
          positionDelta: lazyPositionDelta(binding.delta),
        });
      }
    }

    const runtimePositionDelta = (
      mesh: THREE.Mesh,
      index: number,
      basePositions: Float32Array,
    ) => {
      const attribute = mesh.geometry.morphAttributes.position?.[index];
      if (!attribute) {
        throw new Error(
          `appearance retained morph ${mesh.name || mesh.uuid}/${index} has no POSITION payload`,
        );
      }
      const values = readVec3Attribute(attribute);
      if (mesh.geometry.morphTargetsRelative) return lazyPositionDelta(values);
      return {
        length: values.length,
        visit(visitor: (scalarIndex: number, value: number) => void) {
          for (
            let scalarIndex = 0;
            scalarIndex < values.length;
            scalarIndex += 1
          ) {
            visitor(
              scalarIndex,
              Math.fround(
                (values[scalarIndex] ?? 0) - (basePositions[scalarIndex] ?? 0),
              ),
            );
          }
        },
      };
    };
    const retainedTargetPositionBindings: AppearanceRecipePhysicalBasis["retainedTargetPositionBindings"] =
      [];
    for (const [index, binding] of validated.bindings.entries()) {
      if (
        this.manifest.targets[binding.target]?.runtimeRetention !==
        "retain-in-live-goon"
      ) {
        continue;
      }
      const runtime = (this.targetBindings.get(binding.target) ?? []).find(
        (candidate) =>
          candidate.mesh.uuid === binding.runtimeNodeId &&
          candidate.morph === binding.morph,
      );
      const basePositions = runtime
        ? meshBasePositions.get(runtime.mesh.uuid)
        : undefined;
      if (!runtime || !basePositions) {
        throw new Error(
          `appearance retained target ${binding.target}/${binding.morph} lost its active mesh`,
        );
      }
      const id = `retained:${index}`;
      this.retainedPhysicalBindings.set(id, runtime);
      retainedTargetPositionBindings.push({
        id,
        targetId: binding.target,
        node: binding.node,
        morph: binding.morph,
        meshId: runtime.mesh.uuid,
        positionDelta: runtimePositionDelta(
          runtime.mesh,
          runtime.index,
          basePositions,
        ),
      });
    }

    const followerMorphPositionBindings: AppearanceRecipePhysicalBasis["followerMorphPositionBindings"] =
      [];
    for (const binding of validated.followerMorphBindings) {
      const runtime = this.bakedFollowerMorphBindings.get(
        binding.follower + "\u0000" + binding.channel,
      );
      if (!runtime) {
        throw new Error(
          `appearance follower ${binding.follower}/${binding.channel} has no baked physical binding`,
        );
      }
      followerMorphPositionBindings.push({
        id: `follower:${binding.follower}:${binding.channel}`,
        follower: binding.follower,
        channel: binding.channel,
        node: binding.node,
        morph: binding.morph,
        meshId: runtime.runtime.mesh.uuid,
        positionDelta: lazyPositionDelta(runtime.delta),
      });
    }
    const followerMorphPositionIdByKey = new Map(
      followerMorphPositionBindings.map((binding) => [
        binding.follower + "\u0000" + binding.channel,
        binding.id,
      ]),
    );
    const followerMorphBindings: AppearanceRecipePhysicalBasis["followerMorphBindings"] =
      [];
    const followerNodeTransformBindings: AppearanceRecipePhysicalBasis["followerNodeTransformBindings"] =
      [];
    for (const [follower, declaration] of Object.entries(
      this.manifest.followers,
    ).sort(([left], [right]) => left.localeCompare(right))) {
      const channels = declaration.drivers
        .flatMap((driver) =>
          driver.channels.map((channel) => ({
            driver: driver.driver,
            channel,
          })),
        )
        .sort((left, right) => left.channel.id.localeCompare(right.channel.id));
      for (const { driver, channel } of channels) {
        if (channel.kind === "morph-weight") {
          const positionBindingId = followerMorphPositionIdByKey.get(
            follower + "\u0000" + channel.id,
          );
          followerMorphBindings.push({
            follower,
            channel: channel.id,
            driver: { ...driver },
            node: channel.node,
            morph: channel.morph,
            ...(positionBindingId ? { positionBindingId } : {}),
          });
        } else {
          const runtime = this.followerNodes.get(channel.node);
          followerNodeTransformBindings.push({
            follower,
            channel: channel.id,
            driver: { ...driver },
            node: channel.node,
            ...(runtime ? { nodeId: runtime.node.uuid } : {}),
          });
        }
      }
    }

    const jointOffsetBindings: AppearanceRecipePhysicalBasis["jointOffsetBindings"] =
      [];
    const seenJointNames = new Set<string>();
    for (const perBone of Object.values(
      this.manifest.jointFollow?.deltas ?? {},
    )) {
      for (const bone of Object.keys(perBone)) {
        if (seenJointNames.has(bone)) continue;
        seenJointNames.add(bone);
        const runtime =
          this.bones.get(bone) ??
          this.bones.get(sanitizeCustomRuntimeNodeName(bone));
        if (!runtime) {
          throw new Error(
            `appearance joint offset ${bone} has no runtime bone`,
          );
        }
        jointOffsetBindings.push({ bone, boneId: runtime.node.uuid });
      }
    }

    const roles: AppearanceRecipePhysicalBasis["roles"] = [];
    for (const [id, declaration] of Object.entries(this.manifest.nodes)) {
      if (declaration.role !== "attachment-anchor") continue;
      const runtime = this.followerNodes.get(id);
      if (!runtime) {
        if (!declaration.required) continue;
        throw new Error(
          `appearance attachment ${id} lost its validated runtime node`,
        );
      }
      roles.push({
        kind: "attachment",
        id,
        nodeId: runtime.node.uuid,
        ...(declaration.parent ? { declaredParent: declaration.parent } : {}),
      });
    }
    for (const [id, nodeName] of Object.entries(
      rawManifest.stage?.anchors ?? {},
    )) {
      if (!nodeName) continue;
      const node = resolveCustomNamedNode(this.root, nodeName);
      if (!node) {
        throw new Error(
          `appearance stage anchor ${id} points to missing node ${nodeName}`,
        );
      }
      roles.push({ kind: "stage", id, nodeId: node.uuid });
    }

    const rawRig = rawManifest.rig;
    if (
      rawRig !== undefined &&
      (typeof rawRig !== "object" || rawRig === null || Array.isArray(rawRig))
    ) {
      throw new Error("appearance avatar.json#rig must be an object");
    }
    const performance = resolveCustomPerformanceRigManifest(
      rawRig === undefined
        ? undefined
        : (rawRig as Record<string, unknown>).performance,
    );
    if (performance.issues.length > 0) {
      throw new Error(
        `appearance malformed rig.performance: ${performance.issues.join(" ")}`,
      );
    }
    if (performance.manifest) {
      const claimed = new Map<string, string>();
      for (const role of ["head", "neck", "leftEye", "rightEye"] as const) {
        const nodeName = performance.manifest.nodes[role].node;
        const node = resolveExactRoleNode(
          nodeName,
          `rig.performance.nodes.${role}.node`,
        );
        const prior = claimed.get(node.uuid);
        if (prior) {
          throw new Error(
            `appearance rig.performance.nodes.${role}.node duplicates ${prior}`,
          );
        }
        claimed.set(node.uuid, `nodes.${role}`);
        roles.push({
          kind: "performance",
          id: `look.${role}`,
          nodeId: node.uuid,
        });
      }
      for (const [role, target] of Object.entries(
        performance.manifest.targetTransforms,
      )) {
        const node = resolveExactRoleNode(
          target.node,
          `rig.performance.targetTransforms.${role}.node`,
        );
        const prior = claimed.get(node.uuid);
        if (prior) {
          throw new Error(
            `appearance rig.performance.targetTransforms.${role}.node duplicates ${prior}`,
          );
        }
        claimed.set(node.uuid, `targetTransforms.${role}`);
        roles.push({
          kind: "performance",
          id: `target.${role}`,
          nodeId: node.uuid,
        });
      }
    }

    if (
      rawManifest.eyeAppearance !== undefined &&
      rawManifest.eyeAppearance !== null
    ) {
      const eye = parseEyeAppearanceDefinition(rawManifest.eyeAppearance);
      const skinJointIds = new Set(
        this.skins.flatMap((skin) =>
          skin.mesh.skeleton.bones.map((bone) => bone.uuid),
        ),
      );
      const claimedAssemblies = new Set<string>();
      for (const side of ["left", "right"] as const) {
        const binding = eye.runtimeBindings[side];
        const eyeBone = resolveExactRoleNode(
          binding.eyeBone,
          `eyeAppearance.runtimeBindings.${side}.eyeBone`,
        );
        if (!skinJointIds.has(eyeBone.uuid)) {
          throw new Error(
            `appearance eyeAppearance ${side} eye bone is not a skin joint`,
          );
        }
        roles.push({
          kind: "eye",
          id: `${side}.bone`,
          nodeId: eyeBone.uuid,
        });
        for (const [assemblyRole, assemblyName] of Object.entries(
          binding.assemblyNodes,
        )) {
          const assembly = resolveExactRoleNode(
            assemblyName,
            `eyeAppearance.runtimeBindings.${side}.assemblyNodes.${assemblyRole}`,
          );
          if (assembly.parent !== eyeBone) {
            throw new Error(
              `appearance eyeAppearance ${side} ${assemblyRole} is not a direct child of its eye bone`,
            );
          }
          if (!(assembly as { isMesh?: boolean }).isMesh) {
            throw new Error(
              `appearance eyeAppearance ${side} ${assemblyRole} is not a mesh node`,
            );
          }
          if (claimedAssemblies.has(assembly.uuid)) {
            throw new Error(
              `appearance eyeAppearance assembly node ${assemblyName} is declared more than once`,
            );
          }
          claimedAssemblies.add(assembly.uuid);
          roles.push({
            kind: "eye",
            id: `${side}.assembly.${assemblyRole}`,
            nodeId: assembly.uuid,
          });
        }
      }
    }

    return {
      contract: APPEARANCE_RECIPE_PHYSICAL_BASIS_CONTRACT,
      rootBaseMatrix: baseMatrix(this.root),
      meshes,
      targets: Object.entries(this.manifest.targets).map(([id, target]) => ({
        id,
        runtimeRetention: target.runtimeRetention,
      })),
      targetPositionBindings,
      retainedTargetPositionBindings,
      followerMorphPositionBindings,
      followerMorphBindings,
      nodes,
      followerNodeBindings: [...this.followerNodes].map(([id, runtime]) => ({
        id,
        nodeId: runtime.node.uuid,
      })),
      followerNodeTransformBindings,
      bones: uniqueBones.map((node) => ({
        id: node.uuid,
        name: node.name,
        nodeId: node.uuid,
      })),
      skins: this.skins.map((skin) => ({
        id: skin.mesh.uuid,
        joints: skin.mesh.skeleton.bones.map((bone, index) => ({
          boneId: bone.uuid,
          baseInverseBindMatrix: skin.baseInverses[index]!.toArray(),
        })),
      })),
      jointOffsetBindings,
      roles,
      ...(this.manifest.jointFollow?.clipRemap?.hipsBone
        ? { hipsBone: this.manifest.jointFollow.clipRemap.hipsBone }
        : {}),
    };
  }

  getState(): ResolvedAppearanceDialState {
    return this.state;
  }

  getValues(): unknown {
    return this.values;
  }

  resolveBone(name: string): THREE.Object3D | null {
    return (
      this.bones.get(name)?.node ??
      this.bones.get(sanitizeCustomRuntimeNodeName(name))?.node ??
      null
    );
  }

  setValues(
    values: AppearanceDialValueState | null | undefined,
  ): ResolvedAppearanceDialState {
    this.values = values ?? null;
    this.state = resolveAppearanceDialState(this.manifest, this.values);
    this.applyResolvedState(this.state);
    return this.state;
  }

  applyTargetInfluences(influences: Map<string, number>) {
    for (const [targetId, value] of influences) {
      for (const binding of this.targetBindings.get(targetId) ?? []) {
        const weights = binding.mesh.morphTargetInfluences;
        if (Array.isArray(weights)) weights[binding.index] = value;
      }
    }
  }

  private applyResolvedState(state: ResolvedAppearanceDialState) {
    const evaluated = evaluateAppearanceRecipePhysicalOutput(
      this.physicalBasis,
      state,
    );

    for (const retained of evaluated.retainedTargetPositionBindings) {
      const binding = this.retainedPhysicalBindings.get(retained.id);
      if (!binding) {
        throw new Error(
          `appearance physical evaluation omitted retained binding ${retained.id}`,
        );
      }
      const weights = binding.mesh.morphTargetInfluences;
      if (Array.isArray(weights)) weights[binding.index] = retained.weight;
    }
    for (const morph of evaluated.followerMorphWeights) {
      const binding = this.followerMorphBindings.get(
        morph.follower + "\u0000" + morph.channel,
      );
      if (!binding) continue;
      const weights = binding.mesh.morphTargetInfluences;
      if (Array.isArray(weights)) weights[binding.index] = morph.weight;
    }

    const evaluatedMeshes = new Map(
      evaluated.meshes.map((mesh) => [mesh.id, mesh.positions]),
    );
    for (const baked of this.bakedMeshes) {
      const positions = evaluatedMeshes.get(baked.mesh.uuid);
      if (!positions) {
        throw new Error(
          `appearance physical evaluation omitted mesh ${baked.mesh.name || baked.mesh.uuid}`,
        );
      }
      const output = baked.position.array as Float32Array;
      output.set(positions);
      baked.bakedBasePosition.set(positions);
      // Recipe morphs mutate the CPU-side base POSITION array after the mesh
      // may already have rendered. WebGPU/WebGL only uploads that new geometry
      // when the attribute version advances.
      baked.position.needsUpdate = true;
    }
    for (const baked of this.bakedMeshes) {
      baked.mesh.geometry.computeVertexNormals();
      baked.mesh.geometry.computeBoundingBox();
      baked.mesh.geometry.computeBoundingSphere();
    }

    const evaluatedNodes = new Map(
      evaluated.nodes.map((node) => [node.id, node.localMatrix]),
    );
    for (const rest of evaluated.jointRests) {
      const runtime = this.physicalNodes.get(rest.nodeId);
      if (!runtime) {
        throw new Error(
          `appearance physical evaluation omitted joint node ${rest.nodeId}`,
        );
      }
      // Joint follow owns local rest translation only. Preserve the scene's
      // exact unowned bone rotation and scale just like the pre-kernel path.
      runtime.position.set(...rest.localPosition);
    }
    for (const runtimeBinding of this.followerNodes.values()) {
      const runtime = runtimeBinding.node;
      const matrix = evaluatedNodes.get(runtime.uuid);
      if (!runtime || !matrix) {
        throw new Error(
          `appearance physical evaluation omitted follower node ${runtime.uuid}`,
        );
      }
      new THREE.Matrix4()
        .fromArray(matrix)
        .decompose(runtime.position, runtime.quaternion, runtime.scale);
    }

    const evaluatedSkins = new Map(
      evaluated.skins.map((skin) => [skin.id, skin]),
    );
    for (const skin of this.skins) {
      const result = evaluatedSkins.get(skin.mesh.uuid);
      if (
        !result ||
        result.joints.length !== skin.mesh.skeleton.boneInverses.length
      ) {
        throw new Error(
          `appearance physical evaluation omitted skin slots for ${skin.mesh.name || skin.mesh.uuid}`,
        );
      }
      result.joints.forEach((joint, index) => {
        skin.mesh.skeleton.boneInverses[index]!.fromArray(
          joint.inverseBindMatrix,
        );
      });
      skin.mesh.skeleton.update();
    }

    this.root.position.set(...evaluated.root.position);
    // Recipe only owns uniform scale and grounding on the runtime root. Keep
    // the captured scene quaternion byte-for-byte instead of round-tripping
    // this unowned value through Matrix4 decomposition.
    this.root.quaternion.copy(this.rootBaseQuaternion);
    this.root.scale.set(...evaluated.root.scale);
    if (this.hipsRemap && evaluated.hipsClipRemap) {
      this.hipsRemap.baseRest.set(...evaluated.hipsClipRemap.baseRest);
      this.hipsRemap.newRest.set(...evaluated.hipsClipRemap.newRest);
      this.hipsRemap.ratio = evaluated.hipsClipRemap.ratio;
      // The legacy engine captured this marker immediately after joint-rest
      // application, before follower nodes. Preserve that ordering when the
      // hips node itself is also follower-owned.
      this.hipsRemap.lastOutput = this.hipsRemap.newRest.clone();
    }
    this.root.updateMatrixWorld(true);
  }

  applyHipsClipRemap() {
    const remap = this.hipsRemap;
    if (!remap) return;
    if (remap.ratio === 1 && remap.newRest.equals(remap.baseRest)) return;
    const position = remap.node.position;
    if (remap.lastOutput && position.equals(remap.lastOutput)) return;
    position.set(
      remap.newRest.x + remap.ratio * (position.x - remap.baseRest.x),
      remap.newRest.y + remap.ratio * (position.y - remap.baseRest.y),
      remap.newRest.z + remap.ratio * (position.z - remap.baseRest.z),
    );
    remap.lastOutput = remap.lastOutput
      ? remap.lastOutput.copy(position)
      : position.clone();
  }
}
