import type * as NodeFsPromises from 'node:fs/promises'

export type QuickOpenFilesystem = Pick<typeof NodeFsPromises, 'lstat' | 'opendir'>
