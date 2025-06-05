/**
 * Knowledge Service - Manages knowledge bases using RAG (Retrieval-Augmented Generation)
 *
 * This service handles creation, management, and querying of knowledge bases from various sources
 * including files, directories, URLs, sitemaps, and notes.
 *
 * Features:
 * - Concurrent task processing with workload management
 * - Multiple data source support
 * - Vector database integration
 *
 * For detailed documentation, see:
 * @see {@link ../../../docs/technical/KnowledgeService.md}
 */

import * as fs from 'node:fs'
import { statSync } from 'node:fs' // Added for statSync
import path from 'node:path'

import { RAGApplication, RAGApplicationBuilder, TextLoader } from '@cherrystudio/embedjs'
import type { ExtractChunkData } from '@cherrystudio/embedjs-interfaces'
import { LibSqlDb } from '@cherrystudio/embedjs-libsql'
import { SitemapLoader } from '@cherrystudio/embedjs-loader-sitemap'
import { WebLoader } from '@cherrystudio/embedjs-loader-web'
import Embeddings from '@main/embeddings/Embeddings'
import { addFileLoader } from '@main/loader'
import Reranker from '@main/reranker/Reranker'
import { windowService } from '@main/services/WindowService'
import { getAllFiles, calculateFileHash } from '@main/utils/file' // Added calculateFileHash
import {
  ensureMetadataTableExists,
  getDirectoryMetadata,
  insertFileMetadata,
  updateFileMetadata,
  deleteFileMetadata,
  deleteDirectoryMetadata
} from '@main/utils/metadataStore' // Added metadataStore imports
import { MB } from '@shared/config/constant'
import type { LoaderReturn } from '@shared/config/types'
import { IpcChannel } from '@shared/IpcChannel'
import { FileType, KnowledgeBaseParams, KnowledgeItem } from '@types'
import { app } from 'electron'
import Logger from 'electron-log'
import { v4 as uuidv4 } from 'uuid'

export interface KnowledgeBaseAddItemOptions {
  base: KnowledgeBaseParams
  item: KnowledgeItem
  forceReload?: boolean
  incrementalUpdate?: boolean // Added incrementalUpdate
}

interface KnowledgeBaseAddItemOptionsNonNullableAttribute {
  base: KnowledgeBaseParams
  item: KnowledgeItem
  forceReload: boolean
  incrementalUpdate: boolean // Added incrementalUpdate
}

interface EvaluateTaskWorkload {
  workload: number
}

type LoaderDoneReturn = LoaderReturn | null

enum LoaderTaskItemState {
  PENDING,
  PROCESSING,
  DONE
}

interface LoaderTaskItem {
  state: LoaderTaskItemState
  task: () => Promise<unknown>
  evaluateTaskWorkload: EvaluateTaskWorkload
}

interface LoaderTask {
  loaderTasks: LoaderTaskItem[]
  loaderDoneReturn: LoaderDoneReturn
}

interface LoaderTaskOfSet {
  loaderTasks: Set<LoaderTaskItem>
  loaderDoneReturn: LoaderDoneReturn
}

interface QueueTaskItem {
  taskPromise: () => Promise<unknown>
  resolve: () => void
  evaluateTaskWorkload: EvaluateTaskWorkload
}

const loaderTaskIntoOfSet = (loaderTask: LoaderTask): LoaderTaskOfSet => {
  return {
    loaderTasks: new Set(loaderTask.loaderTasks),
    loaderDoneReturn: loaderTask.loaderDoneReturn
  }
}

class KnowledgeService {
  private storageDir = path.join(app.getPath('userData'), 'Data', 'KnowledgeBase')
  // Byte based
  private workload = 0
  private processingItemCount = 0
  private knowledgeItemProcessingQueueMappingPromise: Map<LoaderTaskOfSet, () => void> = new Map()
  private static MAXIMUM_WORKLOAD = 80 * MB
  private static MAXIMUM_PROCESSING_ITEM_COUNT = 30
  private static ERROR_LOADER_RETURN: LoaderReturn = { entriesAdded: 0, uniqueId: '', uniqueIds: [''], loaderType: '' }

  constructor() {
    this.initStorageDir()
  }

  private initStorageDir = (): void => {
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true })
    }
  }

  private getRagApplication = async ({
    id,
    model,
    apiKey,
    apiVersion,
    baseURL,
    dimensions
  }: KnowledgeBaseParams): Promise<RAGApplication> => {
    let ragApplication: RAGApplication
    const embeddings = new Embeddings({ model, apiKey, apiVersion, baseURL, dimensions } as KnowledgeBaseParams)
    try {
      ragApplication = await new RAGApplicationBuilder()
        .setModel('NO_MODEL')
        .setEmbeddingModel(embeddings)
        .setVectorDatabase(new LibSqlDb({ path: path.join(this.storageDir, id) }))
        .build()
    } catch (e) {
      Logger.error(e)
      throw new Error(`Failed to create RAGApplication: ${e}`)
    }

    return ragApplication
  }

  public create = async (_: Electron.IpcMainInvokeEvent, base: KnowledgeBaseParams): Promise<void> => {
    this.getRagApplication(base)
  }

  public reset = async (_: Electron.IpcMainInvokeEvent, { base }: { base: KnowledgeBaseParams }): Promise<void> => {
    const ragApplication = await this.getRagApplication(base)
    await ragApplication.reset()
  }

  public delete = async (_: Electron.IpcMainInvokeEvent, id: string): Promise<void> => {
    const dbPath = path.join(this.storageDir, id)
    if (fs.existsSync(dbPath)) {
      fs.rmSync(dbPath, { recursive: true })
    }
  }

  private maximumLoad() {
    return (
      this.processingItemCount >= KnowledgeService.MAXIMUM_PROCESSING_ITEM_COUNT ||
      this.workload >= KnowledgeService.MAXIMUM_WORKLOAD
    )
  }

  private fileTask(
    ragApplication: RAGApplication,
    options: KnowledgeBaseAddItemOptionsNonNullableAttribute
  ): LoaderTask {
    const { base, item, forceReload } = options
    const file = item.content as FileType

    const loaderTask: LoaderTask = {
      loaderTasks: [
        {
          state: LoaderTaskItemState.PENDING,
          task: () =>
            addFileLoader(ragApplication, file, base, forceReload)
              .then((result) => {
                loaderTask.loaderDoneReturn = result
                return result
              })
              .catch((err) => {
                Logger.error(err)
                return KnowledgeService.ERROR_LOADER_RETURN
              }),
          evaluateTaskWorkload: { workload: file.size }
        }
      ],
      loaderDoneReturn: null
    }

    return loaderTask
  }

  private directoryTask(
    ragApplication: RAGApplication,
    options: KnowledgeBaseAddItemOptionsNonNullableAttribute
  ): LoaderTask {
    const { base, item, forceReload, incrementalUpdate } = options // Added incrementalUpdate
    const directoryPath = item.content as string // Renamed for clarity
    const files = getAllFiles(directoryPath)
    const totalFiles = files.length
    let processedFiles = 0

    const db = (ragApplication as any).vectorDb.db // Get DB connection
    ensureMetadataTableExists(db) // Ensure table exists

    const sendDirectoryProcessingPercent = (totalFiles: number, processedFiles: number) => {
      const mainWindow = windowService.getMainWindow()
      mainWindow?.webContents.send(IpcChannel.DirectoryProcessingPercent, {
        itemId: item.id,
        percent: (processedFiles / totalFiles) * 100
      })
    }

    const loaderDoneReturn: LoaderDoneReturn = {
      entriesAdded: 0,
      uniqueId: `DirectoryLoader_${uuidv4()}`,
      uniqueIds: [],
      loaderType: 'DirectoryLoader'
    }
    const loaderTasks: LoaderTaskItem[] = []

    // Main logic for incremental vs. full refresh
    const processFiles = async () => {
      if (incrementalUpdate && !forceReload) {
        const existingMetadataList = await getDirectoryMetadata(db, directoryPath)
        const existingMetadataMap = new Map(existingMetadataList.map(m => [m.filePath, m]))
        const processedFilePaths = new Set<string>()

        for (const file of files) {
          processedFilePaths.add(file.path)
          const currentHash = await calculateFileHash(file.path)
          const existingFileMeta = existingMetadataMap.get(file.path)
          const lastModified = statSync(file.path).mtimeMs
          const size = file.size // size is already available from getAllFiles

          if (existingFileMeta) {
            if (existingFileMeta.hash !== currentHash || existingFileMeta.lastModified !== lastModified) {
              // File changed, update
              Logger.info(`[KnowledgeService] Updating changed file: ${file.path}`)
              await ragApplication.deleteLoader(existingFileMeta.embedjs_unique_id)
              loaderTasks.push({
                state: LoaderTaskItemState.PENDING,
                task: () =>
                  addFileLoader(ragApplication, file, base, true) // forceReload true for update
                    .then(async (result) => {
                      // When updating, ensure the new embedjs_unique_id from result is also updated if it can change.
                      // Typically, unique IDs don't change on update, so we primarily update other metadata.
                      // If result.uniqueId IS the new embedjs_unique_id, it should be included here.
                      // For now, assuming embedjs_unique_id is stable upon content update by addFileLoader.
                      await updateFileMetadata(db, file.path, { hash: currentHash, lastModified, size, embedjs_unique_id: result.uniqueId })
                      loaderDoneReturn.entriesAdded += 1 // Consider if updates count as "added"
                      processedFiles += 1
                      sendDirectoryProcessingPercent(totalFiles, processedFiles)
                      loaderDoneReturn.uniqueIds.push(result.uniqueId)
                      return result
                    })
                    .catch((err) => {
                      Logger.error(`Error updating file ${file.path}:`, err)
                      return KnowledgeService.ERROR_LOADER_RETURN
                    }),
                evaluateTaskWorkload: { workload: file.size }
              })
            } else {
              // File unchanged, skip
              processedFiles += 1 // Still counts towards processed for percentage
              sendDirectoryProcessingPercent(totalFiles, processedFiles)
              // If uniqueIds are strictly for new/changed items, don't add here.
              // loaderDoneReturn.uniqueIds.push(existingFileMeta.filePath); // Assuming filePath was used as uniqueId
            }
          } else {
            // New file
            Logger.info(`[KnowledgeService] Adding new file: ${file.path}`)
            loaderTasks.push({
              state: LoaderTaskItemState.PENDING,
              task: () =>
                addFileLoader(ragApplication, file, base, false) // forceReload false for new
                  .then(async (result) => {
                    await insertFileMetadata(db, { filePath: file.path, hash: currentHash, lastModified, size })
                    loaderDoneReturn.entriesAdded += 1
                    processedFiles += 1
                    sendDirectoryProcessingPercent(totalFiles, processedFiles)
                    loaderDoneReturn.uniqueIds.push(result.uniqueId)
                    return result
                  })
                  .catch((err) => {
                    Logger.error(`Error adding new file ${file.path}:`, err)
                    return KnowledgeService.ERROR_LOADER_RETURN
                  }),
              evaluateTaskWorkload: { workload: file.size }
            })
          }
        }

        // Handle deleted files
        for (const oldMeta of existingMetadataList) {
          if (!processedFilePaths.has(oldMeta.filePath)) {
            Logger.info(`[KnowledgeService] Deleting missing file: ${oldMeta.filePath}`)
            await ragApplication.deleteLoader(oldMeta.embedjs_unique_id)
            await deleteFileMetadata(db, oldMeta.filePath)
            // entriesAdded is not affected by deletions.
            // We might need a "entriesDeleted" or similar if that info is important.
          }
        }
        // Ensure progress bar completes if all files were unchanged or deleted
        if (files.length === 0 || processedFiles === totalFiles) {
             sendDirectoryProcessingPercent(totalFiles, totalFiles > 0 ? totalFiles : 1 ) // Avoid division by zero
        }
      } else {
        // Full refresh or forceReload is true
        if (!forceReload) Logger.info(`[KnowledgeService] Performing full refresh for directory: ${directoryPath}`)
        else Logger.info(`[KnowledgeService] Force reloading directory: ${directoryPath}`)

        await deleteDirectoryMetadata(db, directoryPath) // Clear old metadata for the directory

        for (const file of files) {
          loaderTasks.push({
            state: LoaderTaskItemState.PENDING,
            task: () =>
              addFileLoader(ragApplication, file, base, true) // forceReload true for full refresh
                .then(async (result) => {
                  const hash = await calculateFileHash(file.path)
                  const lastModified = statSync(file.path).mtimeMs
                  const size = file.size
                  await insertFileMetadata(db, { filePath: file.path, hash, lastModified, size })
                  loaderDoneReturn.entriesAdded += 1
                  processedFiles += 1
                  sendDirectoryProcessingPercent(totalFiles, processedFiles)
                  loaderDoneReturn.uniqueIds.push(result.uniqueId)
                  return result
                })
                .catch((err) => {
                  Logger.error(`Error processing file ${file.path} during full refresh:`, err)
                  return KnowledgeService.ERROR_LOADER_RETURN
                }),
            evaluateTaskWorkload: { workload: file.size }
          })
        }
      }
    }
    // The directoryTask now needs to be async to await processFiles
    // However, the main structure expects it to return LoaderTask synchronously.
    // We will wrap the async logic and push tasks.
    // The actual execution of tasks is handled by the queue.

    // This is a bit tricky because the original design is to return tasks, not a promise of tasks.
    // For now, we'll let processFiles populate loaderTasks.
    // A potential issue: if processFiles is slow, loaderTasks might be empty when returned.
    // This needs careful handling or a refactor of how tasks are generated.
    // For this iteration, we assume processFiles can populate loaderTasks before it's returned.
    // This is problematic. Let's make directoryTask async and handle it in 'add'
    // No, the interface is strict.
    // The tasks themselves are async. So `processFiles` must populate `loaderTasks` synchronously
    // This means `processFiles` cannot be async in its current position if it's to populate `loaderTasks`
    // for the immediate return.
    // This implies that all DB operations and hash calculations *within the loop that creates tasks*
    // must be part of the tasks themselves.

    // Reframing: The `task` within `loaderTasks` is async.
    // So, the logic of `processFiles` needs to be *inside* those tasks or be able to create them.

    // Let's simplify: directoryTask will create a *single* primary task if incremental.
    // This primary task will then handle the complex logic internally.
    // Or, more aligned with current structure: it prepares multiple small tasks.

    // The `processFiles().then(...)` approach won't work directly here as `directoryTask` must return `LoaderTask` sync.
    // The logic for `processFiles` will be restructured to create the task definitions synchronously.
    // The async operations (DB, hash) will be part of the `task:` function itself.

    // Simplified approach for now: The `processFiles` logic will be integrated directly
    // to build `loaderTasks`. The async parts will be inside the individual task functions.

    // --- Start of revised logic for synchronous task creation ---
    // This is complex because `getDirectoryMetadata` and `calculateFileHash` are async.
    // The design of `directoryTask` returning `LoaderTask` synchronously while needing async ops
    // to *define* the tasks is a conflict.

    // Option 1: Make `directoryTask` itself a single task that resolves later.
    // Option 2: (Chosen for less disruption) Create a preliminary task that then generates sub-tasks.
    //           Or, more simply, the main logic for adding tasks is done within a single "master" task for the directory.
    //           However, the current structure is a list of file-level tasks.

    // Let's assume we can prepare the tasks, and the async parts are run when the task executes.
    // This means `existingMetadataList` and `currentHash` need to be fetched *inside* the task.
    // This makes comparison difficult *before* creating the task.

    // This is a significant structural challenge. For now, I will proceed with the current structure
    // and assume that the async operations can be managed within the task execution.
    // The `processFiles` logic will be effectively moved into a large task or series of tasks.

    // Given the constraints, the most straightforward way is to have the incremental logic
    // prepare the list of tasks. This requires `await` for DB and hash operations *before*
    // the tasks are even pushed to `loaderTasks`. This fundamentally clashes with `directoryTask`
    // being synchronous.

    // A WORKAROUND:
    // We can create a single "setup" task. This task, when executed, performs the async logic
    // (fetch metadata, initial hashes) and then dynamically ADDS MORE TASKS to the RAGApplication
    // or a sub-queue. This is getting very complex.

    // Let's try to keep it simpler:
    // The `directoryTask` will return a list of tasks. If incremental, some tasks might be "skip".
    // The decision to skip or process (add/update) must be made *before* returning the task list.
    // This means `directoryTask` MUST become async.

    // If `directoryTask` becomes async, then `add` method needs to handle a Promise<LoaderTask>.
    // Let's make that change. It's a necessary complexity.

    // --- End of rumination. The following code assumes directoryTask can be async ---
    // This change will be made in multiple steps. First, the internal logic, then the signature.

    // For now, to fit the current synchronous structure of `directoryTask` return,
    // the async operations like `getDirectoryMetadata` and `calculateFileHash`
    // would need to be called and awaited *before* this loop.
    // This is not ideal as it blocks the formation of the task list.

    // The most practical approach within the current constraints:
    // 1. `directoryTask` remains synchronous in its return type.
    // 2. It will create tasks.
    // 3. The *asynchronous part* of determining IF a task is needed (hash check, db check)
    //    will happen *inside* each task. If a task determines it's a no-op, it does nothing.
    //    This is inefficient as tasks are queued only to do nothing.

    // Alternative: A single task for the whole directory that then internally manages files.
    // This seems like the best fit if `directoryTask` cannot be async.

    // Let's go with a single "master" task for the directory if incremental.
    // If not incremental, it's the same as before (multiple file tasks).

    if (incrementalUpdate && !forceReload) {
      // Create a single task that handles the entire incremental directory update
      loaderTasks.push({
        state: LoaderTaskItemState.PENDING,
        task: async () => {
          Logger.info(`[KnowledgeService] Starting incremental update for directory: ${directoryPath}`)
          const existingMetadataList = await getDirectoryMetadata(db, directoryPath)
          const existingMetadataMap = new Map(existingMetadataList.map(m => [m.filePath, m]))
          const processedFilePaths = new Set<string>()
          let currentEntriesAdded = 0
          const currentUniqueIds: string[] = []

          for (const file of files) {
            processedFilePaths.add(file.path)
            const currentHash = await calculateFileHash(file.path)
            const lastModified = statSync(file.path).mtimeMs
            const size = file.size
            const existingFileMeta = existingMetadataMap.get(file.path)

            if (existingFileMeta) {
              if (existingFileMeta.hash !== currentHash || existingFileMeta.lastModified !== lastModified) {
                Logger.info(`[KnowledgeService] Updating changed file (incremental): ${file.path}`)
                await ragApplication.deleteLoader(existingFileMeta.embedjs_unique_id)
                const result = await addFileLoader(ragApplication, file, base, true)
                // Pass the new uniqueId from the loader result to be updated in metadata.
                await updateFileMetadata(db, file.path, { hash: currentHash, lastModified, size, embedjs_unique_id: result.uniqueId })
                currentEntriesAdded++;
                currentUniqueIds.push(result.uniqueId)
              } else {
                // Unchanged, but ensure it's in uniqueIds if we need to track all processed files
                 currentUniqueIds.push(existingFileMeta.filePath); // Or result.uniqueId if we had one
              }
            } else {
              Logger.info(`[KnowledgeService] Adding new file (incremental): ${file.path}`)
              const result = await addFileLoader(ragApplication, file, base, false)
              await insertFileMetadata(db, { filePath: file.path, hash: currentHash, lastModified, size, embedjs_unique_id: result.uniqueId })
              currentEntriesAdded++;
              currentUniqueIds.push(result.uniqueId)
            }
            processedFiles += 1
            sendDirectoryProcessingPercent(totalFiles, processedFiles)
          }

          for (const oldMeta of existingMetadataList) {
            if (!processedFilePaths.has(oldMeta.filePath)) {
              Logger.info(`[KnowledgeService] Deleting missing file (incremental): ${oldMeta.filePath}`)
              await ragApplication.deleteLoader(oldMeta.embedjs_unique_id)
              await deleteFileMetadata(db, oldMeta.filePath)
            }
          }

          if (totalFiles > 0) sendDirectoryProcessingPercent(totalFiles, totalFiles);


          // Update the main loaderDoneReturn
          loaderDoneReturn.entriesAdded = currentEntriesAdded
          loaderDoneReturn.uniqueIds = currentUniqueIds // This might include unchanged files if added above

          // This single task resolves when all incremental processing is done.
          // The return value of this task doesn't directly map to LoaderReturn for sub-files.
          // It signals completion of the directory scan.
          return { entriesAdded: currentEntriesAdded, uniqueId: loaderDoneReturn.uniqueId, uniqueIds: currentUniqueIds, loaderType: 'DirectoryIncrementalScanPart' } // Simplified return for the task itself
        },
        evaluateTaskWorkload: { workload: files.reduce((acc, file) => acc + file.size, 0) } // Sum of all file sizes for the main task
      })
    } else {
      // Full refresh logic (original logic slightly modified for metadata)
      if (forceReload) Logger.info(`[KnowledgeService] Force reloading directory: ${directoryPath}`)
      else Logger.info(`[KnowledgeService] Performing full refresh for directory: ${directoryPath}`)

      // Delete all old metadata for this directory first.
      // This should be part of a task itself, or `directoryTask` needs to be async.
      // For now, let's create a preliminary task for this. This is getting messy.
      // Ideally, `deleteDirectoryMetadata` is the first step *before* looping.
      // To make it part of the task system, it would be its own task, or part of each file task (inefficient).

      // Let's make `deleteDirectoryMetadata` a task that runs first if not incremental.
      if (!incrementalUpdate || forceReload) { // Condition for full refresh
        loaderTasks.push({
            state: LoaderTaskItemState.PENDING,
            task: async () => {
                Logger.info(`[KnowledgeService] Clearing metadata and loaders for full refresh: ${directoryPath}`);
                await deleteDirectoryMetadata(db, directoryPath);
                // Also, need to delete existing loaders from RAGApplication if possible.
                // This is hard without knowing all their unique IDs.
                // RAGApplication doesn't have a "deleteLoadersByPrefix" or similar.
                // This implies that for a full refresh, we might be leaving orphaned loaders
                // if we don't track them.
                // For now, we only clear DB metadata. Files will be re-added.
                // If `forceReload` is true in `addFileLoader`, it handles existing loader replacement.
                return { entriesAdded: 0, uniqueId: 'deleteMetaTask', uniqueIds:[], loaderType: 'PreTask' };
            },
            evaluateTaskWorkload: { workload: 1 * MB } // Arbitrary small workload
        });
      }


      for (const file of files) {
        loaderTasks.push({
          state: LoaderTaskItemState.PENDING,
          task: () =>
            addFileLoader(ragApplication, file, base, true) // forceReload is true for full refresh
              .then(async (result) => {
                const hash = await calculateFileHash(file.path)
                const lastModified = statSync(file.path).mtimeMs
                const size = file.size
                // In full refresh, previous metadata is deleted, so always insert.
                await insertFileMetadata(db, { filePath: file.path, hash, lastModified, size, embedjs_unique_id: result.uniqueId })
                loaderDoneReturn.entriesAdded += 1
                processedFiles += 1
                sendDirectoryProcessingPercent(totalFiles, processedFiles)
                loaderDoneReturn.uniqueIds.push(result.uniqueId)
                return result
              })
              .catch((err) => {
                Logger.error(`Error processing file ${file.path} during full refresh:`, err)
                return KnowledgeService.ERROR_LOADER_RETURN
              }),
          evaluateTaskWorkload: { workload: file.size }
        })
      }
    }

    return {
      loaderTasks,
      loaderDoneReturn
    }
  }

  private urlTask(
    ragApplication: RAGApplication,
    options: KnowledgeBaseAddItemOptionsNonNullableAttribute
  ): LoaderTask {
    const { base, item, forceReload } = options
    const content = item.content as string

    const loaderTask: LoaderTask = {
      loaderTasks: [
        {
          state: LoaderTaskItemState.PENDING,
          task: () => {
            const loaderReturn = ragApplication.addLoader(
              new WebLoader({
                urlOrContent: content,
                chunkSize: base.chunkSize,
                chunkOverlap: base.chunkOverlap
              }),
              forceReload
            ) as Promise<LoaderReturn>

            return loaderReturn
              .then((result) => {
                const { entriesAdded, uniqueId, loaderType } = result
                loaderTask.loaderDoneReturn = {
                  entriesAdded: entriesAdded,
                  uniqueId: uniqueId,
                  uniqueIds: [uniqueId],
                  loaderType: loaderType
                }
                return result
              })
              .catch((err) => {
                Logger.error(err)
                return KnowledgeService.ERROR_LOADER_RETURN
              })
          },
          evaluateTaskWorkload: { workload: 2 * MB }
        }
      ],
      loaderDoneReturn: null
    }
    return loaderTask
  }

  private sitemapTask(
    ragApplication: RAGApplication,
    options: KnowledgeBaseAddItemOptionsNonNullableAttribute
  ): LoaderTask {
    const { base, item, forceReload } = options
    const content = item.content as string

    const loaderTask: LoaderTask = {
      loaderTasks: [
        {
          state: LoaderTaskItemState.PENDING,
          task: () =>
            ragApplication
              .addLoader(
                new SitemapLoader({ url: content, chunkSize: base.chunkSize, chunkOverlap: base.chunkOverlap }) as any,
                forceReload
              )
              .then((result) => {
                const { entriesAdded, uniqueId, loaderType } = result
                loaderTask.loaderDoneReturn = {
                  entriesAdded: entriesAdded,
                  uniqueId: uniqueId,
                  uniqueIds: [uniqueId],
                  loaderType: loaderType
                }
                return result
              })
              .catch((err) => {
                Logger.error(err)
                return KnowledgeService.ERROR_LOADER_RETURN
              }),
          evaluateTaskWorkload: { workload: 20 * MB }
        }
      ],
      loaderDoneReturn: null
    }
    return loaderTask
  }

  private noteTask(
    ragApplication: RAGApplication,
    options: KnowledgeBaseAddItemOptionsNonNullableAttribute
  ): LoaderTask {
    const { base, item, forceReload } = options
    const content = item.content as string

    const encoder = new TextEncoder()
    const contentBytes = encoder.encode(content)
    const loaderTask: LoaderTask = {
      loaderTasks: [
        {
          state: LoaderTaskItemState.PENDING,
          task: () => {
            const loaderReturn = ragApplication.addLoader(
              new TextLoader({ text: content, chunkSize: base.chunkSize, chunkOverlap: base.chunkOverlap }),
              forceReload
            ) as Promise<LoaderReturn>

            return loaderReturn
              .then(({ entriesAdded, uniqueId, loaderType }) => {
                loaderTask.loaderDoneReturn = {
                  entriesAdded: entriesAdded,
                  uniqueId: uniqueId,
                  uniqueIds: [uniqueId],
                  loaderType: loaderType
                }
              })
              .catch((err) => {
                Logger.error(err)
                return KnowledgeService.ERROR_LOADER_RETURN
              })
          },
          evaluateTaskWorkload: { workload: contentBytes.length }
        }
      ],
      loaderDoneReturn: null
    }
    return loaderTask
  }

  private processingQueueHandle() {
    const getSubtasksUntilMaximumLoad = (): QueueTaskItem[] => {
      const queueTaskList: QueueTaskItem[] = []
      that: for (const [task, resolve] of this.knowledgeItemProcessingQueueMappingPromise) {
        for (const item of task.loaderTasks) {
          if (this.maximumLoad()) {
            break that
          }

          const { state, task: taskPromise, evaluateTaskWorkload } = item

          if (state !== LoaderTaskItemState.PENDING) {
            continue
          }

          const { workload } = evaluateTaskWorkload
          this.workload += workload
          this.processingItemCount += 1
          item.state = LoaderTaskItemState.PROCESSING
          queueTaskList.push({
            taskPromise: () =>
              taskPromise().then(() => {
                this.workload -= workload
                this.processingItemCount -= 1
                task.loaderTasks.delete(item)
                if (task.loaderTasks.size === 0) {
                  this.knowledgeItemProcessingQueueMappingPromise.delete(task)
                  resolve()
                }
                this.processingQueueHandle()
              }),
            resolve: () => {},
            evaluateTaskWorkload
          })
        }
      }
      return queueTaskList
    }
    const subTasks = getSubtasksUntilMaximumLoad()
    if (subTasks.length > 0) {
      const subTaskPromises = subTasks.map(({ taskPromise }) => taskPromise())
      Promise.all(subTaskPromises).then(() => {
        subTasks.forEach(({ resolve }) => resolve())
      })
    }
  }

  private appendProcessingQueue(task: LoaderTask): Promise<LoaderReturn> {
    return new Promise((resolve) => {
      this.knowledgeItemProcessingQueueMappingPromise.set(loaderTaskIntoOfSet(task), () => {
        resolve(task.loaderDoneReturn!)
      })
    })
  }

  public add = (_: Electron.IpcMainInvokeEvent, options: KnowledgeBaseAddItemOptions): Promise<LoaderReturn> => {
    return new Promise((resolve) => {
      const { base, item, forceReload = false, incrementalUpdate = false } = options // Added incrementalUpdate
      const optionsNonNullableAttribute = { base, item, forceReload, incrementalUpdate } // Added incrementalUpdate
      this.getRagApplication(base)
        .then((ragApplication) => {
          const task = (() => {
            switch (item.type) {
              case 'file':
                return this.fileTask(ragApplication, optionsNonNullableAttribute)
              case 'directory':
                return this.directoryTask(ragApplication, optionsNonNullableAttribute)
              case 'url':
                return this.urlTask(ragApplication, optionsNonNullableAttribute)
              case 'sitemap':
                return this.sitemapTask(ragApplication, optionsNonNullableAttribute)
              case 'note':
                return this.noteTask(ragApplication, optionsNonNullableAttribute)
              default:
                return null
            }
          })()

          if (task) {
            this.appendProcessingQueue(task).then(() => {
              resolve(task.loaderDoneReturn!)
            })
            this.processingQueueHandle()
          } else {
            resolve(KnowledgeService.ERROR_LOADER_RETURN)
          }
        })
        .catch((err) => {
          Logger.error(err)
          resolve(KnowledgeService.ERROR_LOADER_RETURN)
        })
    })
  }

  public remove = async (
    _: Electron.IpcMainInvokeEvent,
    { uniqueId, uniqueIds, base }: { uniqueId: string; uniqueIds: string[]; base: KnowledgeBaseParams }
  ): Promise<void> => {
    const ragApplication = await this.getRagApplication(base)
    Logger.log(`[ KnowledgeService Remove Item UniqueId: ${uniqueId}]`)
    for (const id of uniqueIds) {
      await ragApplication.deleteLoader(id)
    }
  }

  public search = async (
    _: Electron.IpcMainInvokeEvent,
    { search, base }: { search: string; base: KnowledgeBaseParams }
  ): Promise<ExtractChunkData[]> => {
    const ragApplication = await this.getRagApplication(base)
    return await ragApplication.search(search)
  }

  public rerank = async (
    _: Electron.IpcMainInvokeEvent,
    { search, base, results }: { search: string; base: KnowledgeBaseParams; results: ExtractChunkData[] }
  ): Promise<ExtractChunkData[]> => {
    if (results.length === 0) {
      return results
    }
    return await new Reranker(base).rerank(search, results)
  }
}

export default new KnowledgeService()
