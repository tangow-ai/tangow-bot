# Self-host computers on Kubernetes

The sandbox supervisor can run bot computers and workers as pods instead of Docker containers. The
app, its API and its database stay as described in [Self-hosting Tangow](./self-host.md); this page
is the contract your manifests must meet. The repository ships no chart or manifests.

## Choose the backend

```bash
SANDBOX_PROVIDER=docker
SUPERVISOR_BACKEND=kubernetes
```

`SUPERVISOR_BACKEND` defaults to `docker`, and `SANDBOX_PROVIDER=e2b` stays available. Any other
value stops the supervisor at startup. So does `SANDBOX_MAX_COMPUTERS_PER_SPACE` above `0`: on
Kubernetes, the namespace's ResourceQuota bounds the number of computers.

## Supervisor settings

| Variable | Value |
| --- | --- |
| `SUPERVISOR_KUBERNETES_NAMESPACE` | Namespace the sandbox pods run in. Required. |
| `SUPERVISOR_KUBERNETES_DATA_CLAIM` | PVC holding `DATA_DIR` in that namespace. Required. |
| `TANGOW_COMPUTER_IMAGE`, `TANGOW_WORKER_IMAGE` | Image references by digest (`repo@sha256:…`). |
| `TANGOW_COMPUTER_MEMORY`, `TANGOW_COMPUTER_CPUS` | Computer limits, as in [resource ceilings](./self-host.md#bot-computer-resource-ceilings). |
| `SUPERVISOR_HOST` | `0.0.0.0`, so the API and worker reach it through its Service. |

`SANDBOX_SUPERVISOR_TOKEN`, `SANDBOX_SUPERVISOR_URL` and `DATA_DIR` work as on Docker. Mount
`DATA_DIR` at the same path in every app pod: the supervisor checks the home paths the API sends.

## Supervisor deployment

- `replicas: 1` with the `Recreate` strategy: its locks are in memory.
- An in-cluster ServiceAccount, bound to the Role below in the sandbox namespace.
- `enableServiceLinks: false` on every app pod. Otherwise a Service named `api` injects
  `API_PORT=tcp://…`, which breaks how the API reads its port.

## RBAC

Grant only this, in the sandbox namespace. The supervisor never lists, watches or deletes by
collection, and must be the only creator of pods there. It does not collect pods it no longer knows
by name: remove orphans yourself by label (`tangow.managed=true`, `tangow.worker=true`).

A computer's pod is named `tangow-bot-<hash>`, where `<hash>` is the first 40 hex characters of the
SHA-256 of the computer's identity, and carries that hash in its `tangow.bot` label. The identity
itself is kept in the `tangow.botId` and `tangow.spaceId` annotations. To find a bot's pod:

```sh
hash=$(printf %s "<identity>" | sha256sum | cut -c1-40)   # macOS: shasum -a 256
kubectl -n <namespace> get pod "tangow-bot-$hash"   # or: get pods -l tangow.bot="$hash"
```

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: tangow-supervisor
  namespace: <sandbox-namespace>
rules:
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["create", "get", "delete"]
  - apiGroups: [""]
    resources: ["pods/exec"]
    verbs: ["create", "get"]
```

## Storage

- One PVC on `DATA_DIR` in each namespace (app and sandboxes), both on the same files. Pods mount it
  by `subPath`; the app creates the directories.
- Sandboxes mount `skills` and `managed-skills` read-only. The supervisor writes `managed-skills`.
- Everything runs as `1000:1000`, without `fsGroup`, so the files must belong to that user.
- The sandbox PVC exposes all of `DATA_DIR`: isolation between computers rests on the subPath the
  supervisor picks.

## Pod security

Sandbox pods meet the Pod Security `restricted` profile and carry no ServiceAccount token. They set
no `runtimeClassName`: an isolated runtime such as Kata is the operator's choice.

## Images

Pods use `imagePullPolicy: Never`: the images must already be on the node, referenced by digest. Pin
them so the kubelet's image garbage collection keeps them, for example with the
`io.cri-containerd.pinned=pinned` label under containerd. A missing image fails the computer with
`ErrImageNeverPull`.

## Resources

- Requests are fixed: computer `2Gi` and `1` CPU, worker `512Mi` and `250m`.
- Computer limits come from `TANGOW_COMPUTER_*` (defaults `8g` and `4`). Keep them set: without a
  limit, a LimitRange default below the request makes the pod invalid. A limit below the request
  stops the supervisor at startup. Worker limits are fixed at `1Gi` and `1` CPU.
- A LimitRange `max` must hold these limits.
- Pids are limited per node by the kubelet's `podPidsLimit`; the computer needs at least `2048`.
  `TANGOW_COMPUTER_PIDS_LIMIT` is ignored.
- A `Terminating` pod still counts in the ResourceQuota: leave room for one more computer than you
  run at once.

## Network

- The supervisor needs no egress except the cluster API server and DNS, and the sandboxes below.
- Into sandboxes: only the web server to port `6080` and the supervisor to `6080` and `7070`. The
  supervisor waits for a computer's screen to be ready on `6080` before handing out its URL. Nothing
  between sandboxes.
- Out of sandboxes: DNS and the Internet, without the cluster and node CIDRs or the cloud metadata
  address.
- App pods reach their dependencies (database, E2B if used). Host firewalls can block pods from
  reaching ports on the node.

A NetworkPolicy for the sandboxes, to adapt to your labels and address ranges:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: tangow-sandboxes
  namespace: <sandbox-namespace>
spec:
  podSelector:
    matchLabels:
      tangow.managed: "true"
  policyTypes: [Ingress, Egress]
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: <app-namespace>
          podSelector:
            matchLabels:
              app: <web-server>
      ports:
        - port: 6080
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: <app-namespace>
          podSelector:
            matchLabels:
              app: <supervisor>
      ports:
        - port: 6080
        - port: 7070
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
          podSelector:
            matchLabels:
              k8s-app: kube-dns
      ports:
        - { protocol: UDP, port: 53 }
        - { protocol: TCP, port: 53 }
    - to:
        - ipBlock:
            cidr: 0.0.0.0/0
            except:
              - <cluster-cidr>
              - <service-cidr>   # some CNIs evaluate policy before DNAT
              - <node-cidr>
              - 169.254.169.254/32
```

## Sleep

A sleeping computer's pod is deleted and its files are kept; it wakes with a cold start. For
near-instant wakes, set `SANDBOX_IDLE_MS` to a large finite value: `Infinity` falls back to the
10-minute default.
