package main

import (
	"time"

	"rt.local/core-go/queue"
	"rt.local/core-go/web"
)

// Queue: owner dead-letter endpoints over an in-memory adapter (local development):
//
//	GET  /admin/app/queue/status          capabilities of the adapter
//	POST /admin/app/queue/failed/inspect  {limit?} → dead letters
//	POST /admin/app/queue/failed/retry    {token} → requeue one dead letter
//
// Swap queue.NewMemory for a broker adapter here; workers share the same *queue.Queue.
func init() {
	register(func(*Components) ([]web.Feature, error) {
		adapter, err := queue.NewMemory(1000, 30*time.Second)
		if err != nil {
			return nil, err
		}
		return []web.Feature{queue.New(adapter).Feature()}, nil
	})
}
