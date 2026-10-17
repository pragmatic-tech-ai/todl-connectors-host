/** The category of an adapter-pack install or load failure. */
export enum AdapterPackErrorKind
{
    InstallFailed = "install-failed",
    LockfileUnreadable = "lockfile-unreadable",
    ManifestMissing = "manifest-missing",
    ManifestInvalid = "manifest-invalid",
    AbiMismatch = "abi-mismatch",
    InvalidName = "invalid-name",
    SignatureInvalid = "signature-invalid",
    SandboxLaunchFailed = "sandbox-launch-failed",
    SandboxCrashed = "sandbox-crashed",
    PackCallFailed = "pack-call-failed",
    SandboxTimeout = "sandbox-timeout"
}

/** A typed failure raised while installing or reading an adapter pack. */
export class AdapterPackError extends Error
{
    private static readonly ErrorName = "AdapterPackError";

    public readonly Kind: AdapterPackErrorKind;

    public constructor(kind: AdapterPackErrorKind, message: string)
    {
        super(message);
        this.name = AdapterPackError.ErrorName;
        this.Kind = kind;
    }
}
