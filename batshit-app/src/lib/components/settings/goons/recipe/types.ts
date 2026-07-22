import type {
  RecipeFailureStage,
  RecipeJobStatus,
  RecipeLiveStatus,
  RecipeMigrationClassification,
  RecipeMigrationReport,
  RecipeBuildDirtyDomain,
  RecipeAuthorUpdateClassification,
} from "$lib/goons/recipe";

export type RecipeEditorStatus =
  "not-initialized" | "ready" | "dirty" | "reviewing";

export type RecipeLifecycleBusyAction =
  "first-bake" | "rebake" | "analyze" | "restore" | null;

export type RecipeFileTechnicalDetails = {
  packageLabel: string;
  modelLabel: string;
  manifestLabel: string;
  contractVersion: number;
  manifestName?: string | null;
};

export type RecipePreviewSide = "current" | "updated";

export type RecipeUpdateFilter = "all" | RecipeMigrationClassification;

export type RecipeAuthorizedPreviewControl = {
  authorization: "server-verified";
  id: string;
  label: string;
  description?: string | null;
  classification: "new" | "reset-required";
  minimum: number;
  maximum: number;
  step: number;
  neutralValue: number;
  value: number;
  unit?: string | null;
  reason: string;
};

export type RecipeLifecyclePresentation = {
  recipeStatus: RecipeEditorStatus;
  liveStatus: RecipeLiveStatus | null;
  preparationEligible?: boolean;
  preparationFailure?: string | null;
  dirtyDomains?: RecipeBuildDirtyDomain[];
  activeVersionAvailable?: boolean;
  recipeRevision: number | null;
  activeRevision: number | null;
  lastFailureStage?: RecipeFailureStage | null;
  fileTechnicalDetails?: RecipeFileTechnicalDetails | null;
};

export type RecipeBuildPresentation = {
  status: RecipeJobStatus | null;
  failureStage?: RecipeFailureStage | null;
  failureReason?: string | null;
  retryable?: boolean;
};

export type RecipeWorkflowViewModel = {
  lifecycle: RecipeLifecyclePresentation & {
    busyAction?: RecipeLifecycleBusyAction;
    canFirstBake?: boolean;
    canRebake?: boolean;
    canAnalyzeUpdate?: boolean;
    canRestorePrevious?: boolean;
    actionsLoading?: boolean;
    actionsUnavailableReason?: string | null;
  };
  report: RecipeMigrationReport | null;
  review: {
    classification?: RecipeAuthorUpdateClassification | null;
    busy?: "updating" | "keeping" | "resetting" | null;
    canUpdateAndRebuild?: boolean;
    canKeepCurrentPackage?: boolean;
    canCleanReset?: boolean;
  };
  preview: {
    side: RecipePreviewSide;
    controls: RecipeAuthorizedPreviewControl[];
    disabled?: boolean;
  };
  build:
    | (RecipeBuildPresentation & {
        status: RecipeJobStatus;
        initialPreparation?: boolean;
        cancelable?: boolean;
        busyAction?: "retrying" | "discarding" | "canceling" | null;
      })
    | null;
  dirtyGuard: {
    open: boolean;
    busy?: "saving" | "discarding" | null;
  };
  confirmations: {
    cleanResetOpen: boolean;
    restoreOpen: boolean;
    previousRevision?: number | null;
    busy?: "clean-reset" | "restore" | null;
  };
};

export type RecipeWorkflowActions = {
  onFirstBake: () => void | Promise<void>;
  onRebake: () => void | Promise<void>;
  onAnalyzeUpdate: () => void | Promise<void>;
  onRequestRestorePrevious: () => void;
  onCancelDirtyGuard: () => void;
  onSaveAndAnalyze: () => void | Promise<void>;
  onDiscardAndAnalyze: () => void | Promise<void>;
  onUpdateAndRebuild: () => void | Promise<void>;
  onKeepCurrentPackage: () => void | Promise<void>;
  onRequestCleanReset: () => void;
  onPreviewSideChange: (side: RecipePreviewSide) => void;
  onPreviewControlChange: (id: string, value: number) => void;
  onPreviewControlCommit?: () => void | Promise<void>;
  onResetPreviewControl?: (id: string) => void;
  onRetryJob: () => void | Promise<void>;
  onDiscardJob: () => void | Promise<void>;
  onCancelBuild?: () => void | Promise<void>;
  onCloseCleanReset: () => void;
  onConfirmCleanReset: () => void | Promise<void>;
  onCloseRestorePrevious: () => void;
  onConfirmRestorePrevious: () => void | Promise<void>;
};
