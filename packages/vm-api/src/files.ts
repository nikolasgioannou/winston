/** Files on the user's VM, through the gateway's file transfer (§15). */
export interface VmFiles {
  read(userId: string, path: string): Promise<Uint8Array>;
  write(
    userId: string,
    path: string,
    bytes: Uint8Array,
  ): Promise<{ size: number }>;
}
