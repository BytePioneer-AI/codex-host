import {
  CodeBuddyAcpClient,
  CodeBuddyAdapter,
  type CodeBuddyAdapterOptions,
} from "@codexhost/adapter-codebuddy";
import type {
  HarnessInspection,
  HarnessResult,
  HarnessSession,
  InspectHarnessInput,
  OpenSessionInput,
} from "@codexhost/harness-adapter";
import { harnessInspectionSchema } from "@codexhost/shared-contracts";
import { workBuddyInvocation } from "./command.js";
import { WORKBUDDY_RUNTIME_PROFILE } from "./common.js";
import {
  WorkBuddyLiveProductContext,
  withWorkBuddyLiveProduct,
  type WorkBuddyLiveProductSnapshotReader,
} from "./live-product.js";
import { mergeWorkBuddyProductModels, type WorkBuddyProductModel } from "./product-models.js";

export type WorkBuddyAdapterOptions = Omit<
  CodeBuddyAdapterOptions,
  "profile" | "invocationFactory"
> & {
  productModels?: () => Promise<readonly WorkBuddyProductModel[]>;
  productSnapshotReader?: WorkBuddyLiveProductSnapshotReader;
  productDesktopExecutable?: (environment: NodeJS.ProcessEnv) => string;
  platform?: NodeJS.Platform;
};

export class WorkBuddyAdapter extends CodeBuddyAdapter {
  readonly #liveProduct: WorkBuddyLiveProductContext | undefined;

  constructor(options: WorkBuddyAdapterOptions = {}) {
    const {
      productModels,
      productSnapshotReader,
      productDesktopExecutable,
      platform = process.platform,
      ...codeBuddyOptions
    } = options;
    const liveProduct =
      platform === "win32"
        ? new WorkBuddyLiveProductContext({
            ...(productModels ? { productModels } : {}),
            ...(productSnapshotReader ? { reader: productSnapshotReader } : {}),
            ...(productDesktopExecutable ? { desktopExecutable: productDesktopExecutable } : {}),
          })
        : undefined;
    const nativeFactory =
      codeBuddyOptions.clientFactory ??
      ((clientOptions) => new CodeBuddyAcpClient(clientOptions, undefined, workBuddyInvocation));
    const windowsProfile = {
      ...WORKBUDDY_RUNTIME_PROFILE,
      allowUnlistedModelSelection: (id: string) => liveProduct?.allowsModel(id) === true,
    };
    super({
      ...codeBuddyOptions,
      profile: platform === "win32" ? windowsProfile : WORKBUDDY_RUNTIME_PROFILE,
      invocationFactory: workBuddyInvocation,
      clientFactory: liveProduct
        ? withWorkBuddyLiveProduct(nativeFactory, liveProduct)
        : nativeFactory,
    });
    this.#liveProduct = liveProduct;
  }

  override async inspect(input: InspectHarnessInput = {}): Promise<HarnessInspection> {
    const inspection = await super.inspect(input);
    if (inspection.status !== "ready") return inspection;
    const productModels = this.#liveProduct?.models ?? [];
    if (productModels.length === 0) return inspection;
    return harnessInspectionSchema.parse({
      ...inspection,
      catalog: mergeWorkBuddyProductModels(inspection.catalog, productModels),
    });
  }

  override async open(input: OpenSessionInput): Promise<HarnessResult<HarnessSession>> {
    if (
      input.kind === "create" &&
      input.executionPolicy === "unattended-full-access" &&
      input.permissionModeId &&
      input.permissionModeId !== "fullAccess"
    ) {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "WorkBuddy: unattended execution requires native fullAccess permissions",
          retryable: false,
        },
      };
    }
    return super.open(input);
  }
}
