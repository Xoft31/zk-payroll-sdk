# Resumable Payroll Batch Handling

The `ResumableBatchManager` provides robust state checkpointing for large payroll disbursements in the ZK Payroll SDK.

## Features
- **State Checkpointing:** Tracks current index, processed item IDs, and failures.
- **Pause & Resume:** Safely interrupt and resume payroll execution flows during network outages or gas spikes.
- **Immutability & Safety:** Prevents modifying completed or failed batches.
