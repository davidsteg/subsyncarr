import { ProcessingCoordinator } from '../coordinator';
import { ProcessingEngine } from '../processingEngine';
import { StateManager } from '../stateManager';
import { EventEmitter } from 'events';

// Mock dependencies
class MockEngine extends EventEmitter {
  processRun = jest.fn();
  reset = jest.fn();
  stateManager: StateManager | undefined;
  skipFile = jest.fn();
  stopAllProcessing = jest.fn();
  requestStop = jest.fn();
  setDryRun = jest.fn();
  isDryRun = jest.fn().mockReturnValue(false);
}

class MockDatabase {
  getSetting = jest.fn().mockReturnValue(null);
  updateRun = jest.fn();
  incrementRunField = jest.fn();
}

class MockStateManager extends EventEmitter {
  db = new MockDatabase();
  createPendingRun = jest.fn();
  getCurrentRun = jest.fn();
  getDatabase = jest.fn(() => this.db);
  appendLog = jest.fn();
  batchAddFiles = jest.fn();
  updateFileStatus = jest.fn();
  updateFileEngine = jest.fn();
  incrementCompletedEngines = jest.fn();
  incrementEngineStat = jest.fn();
  incrementRunCounter = jest.fn();
  completeRun = jest.fn();
  getFileResults = jest.fn().mockReturnValue([]);
  cancelRun = jest.fn();
}

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('ProcessingCoordinator', () => {
  let coordinator: ProcessingCoordinator;
  let mockEngine: MockEngine;
  let mockStateManager: MockStateManager;
  const runId = 'test-run-id';

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    mockEngine = new MockEngine();
    mockStateManager = new MockStateManager();
    mockStateManager.createPendingRun.mockReturnValue(runId);
    mockStateManager.getCurrentRun.mockReturnValue({ id: runId, status: 'running' });
    coordinator = new ProcessingCoordinator(
      mockEngine as unknown as ProcessingEngine,
      mockStateManager as unknown as StateManager,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns the pending run id immediately and records scan results', async () => {
    mockEngine.processRun.mockImplementation(async () => {
      await tick(20);
      mockEngine.emit('run:files_found', ['a.srt', 'b.srt']);
    });

    const id = await coordinator.startRun();
    expect(id).toBe(runId);
    expect(coordinator.isRunning()).toBe(true);

    await tick(50);
    expect(mockStateManager.batchAddFiles).toHaveBeenCalledWith(runId, ['a.srt', 'b.srt']);
    expect(mockStateManager.db.updateRun).toHaveBeenCalledWith(runId, expect.objectContaining({ total_files: 2 }));
    expect(mockStateManager.completeRun).toHaveBeenCalledWith(runId);
    expect(coordinator.isRunning()).toBe(false);
  });

  it('rejects a second run while one is in progress', async () => {
    mockEngine.processRun.mockImplementation(() => tick(50));
    await coordinator.startRun();
    await expect(coordinator.startRun()).rejects.toThrow('A run is already in progress');
    await tick(80);
  });

  it('stops a run during the scan, covering files not yet discovered', async () => {
    mockEngine.processRun.mockImplementation(() => tick(50));
    mockStateManager.getFileResults.mockReturnValue([{ file_path: 'file1.srt' }]);

    await coordinator.startRun();
    coordinator.stopRun();

    expect(mockEngine.requestStop).toHaveBeenCalled();
    expect(mockEngine.stopAllProcessing).toHaveBeenCalledWith(['file1.srt']);
    expect(mockStateManager.cancelRun).toHaveBeenCalledWith(runId);
    await tick(80);
  });

  it('honours the saved dry-run setting', async () => {
    mockStateManager.db.getSetting.mockReturnValue('true');
    mockEngine.processRun.mockResolvedValue(undefined);
    await coordinator.startRun();
    expect(mockEngine.setDryRun).toHaveBeenCalledWith(true);
    await tick(10);
  });

  it('finalizes the run when processing throws', async () => {
    mockEngine.processRun.mockRejectedValue(new Error('Scan failed'));
    await coordinator.startRun();
    await tick(10);
    expect(mockStateManager.completeRun).toHaveBeenCalledWith(runId);
    expect(coordinator.isRunning()).toBe(false);
  });
});
