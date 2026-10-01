```
+-----------------------+   +-----------------------+        +-----------------------+
|       STATE(S)        |   |     I/O Packets       |\       |     DEPENDENCIES      |
|-----------------------|   |-----------------------| \      |-----------------------|
|+ Determines Behaviour |   |+ Data emitted for the |  \     |+ Catalyst for turning |
|+ Serializable         |   |  purpose of           |   \    |  itself or parts of it|
|+ Confurable to define |   |  communication        |    \   |  on/off               |
|  what may be exposed  |   |+ Must include rules of|     \  |+ Required for feature |
|  to other subsystems  |   |  engagement           |     /  |  interoperability and |
+-----------------------+   |+ Payload can only be  |    /   |  compatibility        |
                            |  accessed once after  |   /    |+ All dependencies are |
                            |  which it is consumed |  /     |  themselves subsystems|
                            |+ Includes headers     | /      |  or a feature within  |
                            |  called 'fingerprints'|/       |  one                  |
                            +-----------------------+        +-----------------------+



+-----------------------+   +-------------------+ +-----------------------+
|  CONTROL INTERFACE    |   |  INITIALIZER(s)   | |  PHYSICAL WORKER(S)   |
|-----------------------|   |-------------------| |-----------------------|
|+ Exposed subroutines  |   |+ Push/Pull based  | |+ Declared dedicated/  |
|  that provides a means|   |  mechanisms that  | |  shared worker files, |
|  by which users can   |   |  that initializes | |  with interfaces for  |
|  execute, mutate or   |   |  the subsystem    | |  receiving, processing|
|  retrieve state       |   |  or part (feature)| |  and dispatching to   |
+-----------------------+   |  of it            | |  the main thread      |
                            |+ Populates the    | |+ Only available on    |
                            |  state, either    | |  compatible envs,     |
                            |  from persistent  | |  unavailable for      |
                            |  storage or with  | |  others               |
                            |  defaults setup   | |+ The processor part of|
                            +-------------------+ |  of the subsystems    |
                                                  |+ There may be multiple|
                                                  |  workers carrying out |
                                                  |  different jobs as a  |
                                                  |  worker is to carry   |
                                                  | out a unit of work    |
                                                  +-----------------------+




+-----------------------+   +-----------------------+  +-----------------------+
|  VIRTUAL WORKER(S)    |   |  HYBRID WORKER(S)     |  |    FEATURES           |
|-----------------------|   |-----------------------|  |-----------------------|
|+ Declared functions   |   |+ A processor for a    |  |+ A part of a subsystem|
|  running in isolated  |   |  subsystem with       |  |  with it's own init,  |
|  parts of the main    |   |  support for both     |  |  processing, wind down|
|  thread such as       |   |  physical and virtual |  |  and state            |
|  'Background Task API'|   |  workers.             |  |+ It is a micro        |
|  , 'setTimeout',      |   |+ Every processor that |  |  subsystem that allows|
|  'setInterval',       |   |  declares a physical  |  |  parts of a subsystem |
|  'Prioritized Task    |   |  worker should also   |  |  to be fully modular  |
|  Scheduler',          |   |  define a virtual one |  |  failure of one does  |
|  'navigator.scheduling|   |  to be used as a      |  |  not result in failure|
|  .isInputPending',    |   |  fallback for         |  |  of all, engendering  |
|  and 'queueMicrotask' |   |  resilience           |  |  resilience           |
|+ Functionally the same|   |+ Some processor may   |  |+ Can communicate with |
|  as a physical worker |   |  use both physical    |  |  other features using |
|  but executes in the  |   |  and virtual workers  |  |  it's own identity i.e|
|  main thread or it's, |   |  to optimize accuracy |  |  without using packets|
|  background           |   +-----------------------+  |  or any other formal  |
+-----------------------+                              |  inter-subsystem      |
                                                       |  protocols. This is   |
                                                       |  only true for those  |
                                                       |  communications within|
                                                       |  the parent subsystem |
                                                       |+ For communications   |
                                                       |  with other subsystems|
                                                       |  , it must use the    |
                                                       |  identity of it's     |
                                                       |  parent and inter-    |
                                                       |  subsystem protocols  |
                                                       |+ As such, features    |
                                                       |  are encapsulated and |
                                                       |  cannot be accessed   |
                                                       |  directly by external |
                                                       |  subsystems           |
                                                       +-----------------------+

















```

# Subsystems

A subsystem is a program in a frontend application (such a browser) that has a `state`, `features`, `packets` and a `control-interface`. Some subsystems are state heavy such as the global state, others are processor, scheduler or destructor heavy.

## Classification of Scopes

Subsystems have a scope depending on what they intend to do

- **Page**: This scope is limited to the url and will be destroyed when it's path (on the url) changes. It can only send messages to other page-bound subsystems, but may receive from any subsystem
- **Tab**: This scope is limited to the browsing tab. It can only send packets to tab-bound subsystems, but may receive from any
- **Window**: This scope is limited to the subdomain context within a session. It can only send packets to session-bound subsystems, but may receive from any
- **Global**: This scope is far reaching to the server context. It can send & receive packets to and from any

## State

The direct properties of the subsystem only directly mutable from this subsystem

## Features

### Initializers

- Checks for dependencies
- Populates the state (i.e via defaults or from a persistent storage)
- Starts up the relevant processors
- Setups any destructors necessary, and pushes the token (argument) used to initialize it. It is the 'on' switch of a subsystem.

### Processors

These are executors and the brains in a subsystem. The ways a processor may be defined may be:

- **Physical Workers**: These are processors declared on a different thread (in js/ts using dedicated or shared workers)
- **Virtual Workers**: These are processors that may run in the background on the main thread. In the js/ts browser api ecosystem, these may be done using unawaited promises, background task api, prioritized task api, `setTimeout`, `setInterval`, `navigator.scheduling` or `window.queueMicrotask`.
- **Hybrid Workers**: A processor with a physical & virtual worker. They may or may not be doing similar work. This is useful for platforms where resources constrain thread usage or outright disallow extra threads, a processor can then declare a physical worker as a default and a virtual worker as a fallback. Some other uses may include using both for speed and/or accuracy

#### Jobs

The jobs that a processor may be assigned to do is:

- _Sinks_: Do something with the packet and update internal state. Don't emit anything
- _Queue_: Internal queues that orders incoming & outgoing packets. They schedule internal work or outgoing responses. It's messaging is 1-to-1
- _Notifiers_: Emits messages using formal protocols so that interested subsystems are able to respond. The subsystem chooses which message, for which processes to emit

### Destructors

Gracefully tears down this subsystem and frees up any used resources. This may also include persisting the current session (i.e the state). It is the 'off' switch of a subsystem

## Packets

It is the payload of the message between subsystems.

In a 1-to-1 channel, these are payloads sent by one subsystem to another using the _Queue_ subsystem - a wrapper around `MessageChannel`. The message is sent directly to the `Queue`, which configures its headers to show source and destination before sending it to the destination subsystem. This header configuration is fingerprinting.

In a 1-to-many channel, they are payloads sent by one subsystem to the notification center - a wrapper around `BroadcastChannel`. The message is sent directly to the notification channel, using the _Queue_ subsystem, both of which configures the packet's header via fingerprinting to show the which subsystems have handled the packet. Finally, the notification center emits the packet and all subscribed subsystem may do something with the payload.

## Control

Exposed subroutines that gives readonly access to state, execution of initialization, processing and ultimately wind down

## Diagrams
The global state, notification center, queue are all subsystems. These are _centralized_ subsystems, as such, their anatomy may be slightly different from _featurized_ subsystems. The biggest difference is that some do not adhere to message protocols, cannot be shutdown down manually (global state) etc

Turn off 'word wrap' to see the diagram clearly

```
                                    +----------+-----------------+
                                    | Incoming | Notifications / |
                                    |  Packet  |     Queue       |
                                    |----------------------------+
+--------+------+                   |+ Finger  |
| GLOBAL | Ctrl |                   |  Prints  |
|---------------+                   |+ Extra   |
| states |                           \ States /
+--------+                            \      /
                                       \    /
                                        \  /
                    +--------------------\/------------------------------+---------------------------+
                    |   Subsystem - Can use global control interfaces    |     Control Interface     |
                    |--------------------------------------------------------------------------------+
                    |  States   |                                        | + getProp1(params?)       |
                    |-----------| +------------------------------------+ | + init5(params?)          |
                    |           | |     Processors                     | | + executeA(params?)       |
                    | +-------+ | |------------------------------------| | + isFlagC(params?)        |
                    | | Prop0 | | |                                    | | + isCheckB(params?)       |
                    | +-------+ | | +--------------------------------+ | |---------------------------+          +--------------+
                    |           | | |  Init: Can use Notifications   |------------------------------------------| Initializers |
                    | +-------+ | | |--------------------------------| | |                                      +--------------+
                    | | Prop1 | | | |                                | | |
                    | +-------+ | | | +---+   +---+   +---+   +---+  | | |
                    |           | | | | 0 |   | 1 |   | . |   | N |  | | |
                    | +-------+ | | | +---+   +---+   +---+   +---+  | | |
                    | |  ...  | | | |                                | | |
                    | +-------+ | | +--------------------------------+ | |
                    |           | |                                    | |
                    |           | | +--------------------------------+ | +>>>>>>>>>>>>>>>>>>+--------------+
                    |           | | | Sinks | Schedulers | Notifiers | | |\  Outgoing Packet \    Queue    |
                    |           | | +--------------------------------+ | | \>>>>>>>>>>>>>>>>>>\------------+
                    |           | |                                    | | / + Fingerprint    /
                    |           | | +--------------------------------+ | |/  + Extra States  /
                    | +-------+ | | | Finalzr: Can use Notifications | |--------------------
                    | | PropN | | | +-------------|------------------+ | |
                    | +-------+ | +---------------|--------------------+ |
                    |           |                 |                      |
                    +-----------------------------|----------------------+
                                                  |
                                                  |       +-------------+
                                                  |-------| Destructors |
                                                          +-------------+
```
