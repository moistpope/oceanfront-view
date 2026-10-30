package ai.sunnypilot.webhud

/**
 * The pure half of [PerfBoost]: what the probe (`assets/perf/probe.sh`) read, what to write to run the
 * head unit flat out, what puts it back, and how much of it took. Nothing here touches the device.
 *
 * - CPU: every cpufreq policy's minimum raised to its maximum. The governor and the thermal limits stay
 *   (a thermal cap lowers the maximum, and the minimum follows it down).
 * - GPU: the same for the GPU's devfreq devices (and its bus, where the SoC has one: Adreno's gpubw).
 * - CAN: the two MCP251x chips' interrupts, and their SPI controller's, moved off CPU 0 (where every
 *   interrupt lands on Pulse) to the last core of CPU 0's cluster, off the big cores the HUD draws on;
 *   and their interrupt threads, with the SPI controller's message thread, raised to SCHED_FIFO
 *   [RT_PRIORITY], above the 50 the kernel gives every interrupt thread.
 */
object PerfPlan {
    /** The first line of the saved restore script: the boot it belongs to. */
    const val BOOT_PREFIX = "# boot "
    const val RT_PRIORITY = 80
    /** Where the READY lamp is: VCU_RdyLamp, IBUS1 0x234 (the helper's "%03X"), byte 1 bit 4. */
    const val READY_ADDR = "234"

    // toybox's: `chrt -p PID PRIORITY` (util-linux and busybox take them the other way round)
    private const val CHRT = "/system/bin/toybox chrt"
    private const val SCHED_OTHER = 0
    private const val SCHED_FIFO = 1
    private const val SCHED_RR = 2
    private const val SCHED_BATCH = 3
    private const val SCHED_IDLE = 5

    private val WS = Regex("""\s+""")
    private val GPU = Regex("gpu|kgsl|mali|pvr|sgx", RegexOption.IGNORE_CASE)
    private val IRQ_THREAD = Regex("""irq/(\d+)-.*""")
    private val SPI_DEVICE = Regex("""spi\d+\.\d+""")
    private val SPI_CONTROLLER = Regex("""spi\d+""")

    data class Cpufreq(val path: String, val min: Long, val max: Long, val cpus: List<Int>)
    data class Devfreq(val path: String, val min: Long, val max: Long) {
        val name: String get() = path.substringAfterLast('/')
    }
    data class Irq(val n: Int, val affinity: String, val desc: String)
    data class Task(val pid: Int, val rtPriority: Int, val policy: Int, val comm: String)
    data class Probe(
        val bootId: String,
        val cpufreq: List<Cpufreq>,
        val devfreq: List<Devfreq>,
        val can: List<String>,
        val irqs: List<Irq>,
        val tasks: List<Task>,
    )

    /** What to run to boost, and what puts every value it changes back. */
    data class Plan(val boost: List<String>, val restore: List<String>)

    data class Count(val done: Int, val of: Int)

    /** How far a probe shows the head unit flat out; [irqCpu] is where the CAN interrupts go (null: no core to move them to). */
    data class Result(val cpu: Count, val gpu: Count, val irqs: Count, val irqCpu: Int?, val threads: Count) {
        override fun toString() = "CPU clusters at top speed ${cpu.done}/${cpu.of}, GPU ${gpu.done}/${gpu.of}, " +
            "CAN interrupts on CPU ${irqCpu ?: "-"} ${irqs.done}/${irqs.of}, CAN threads at RT $RT_PRIORITY ${threads.done}/${threads.of}"
    }

    fun parse(text: String): Probe {
        var boot = ""
        val cpufreq = ArrayList<Cpufreq>()
        val devfreq = ArrayList<Devfreq>()
        val can = ArrayList<String>()
        val irqs = ArrayList<Irq>()
        val tasks = ArrayList<Task>()
        for (line in text.lineSequence()) {
            val f = line.trim().split(WS)
            when (f[0]) {
                "boot" -> if (f.size >= 2 && f[1] != "-") boot = f[1]
                "cpufreq" -> {
                    val min = f.getOrNull(2)?.toLongOrNull()
                    val max = f.getOrNull(3)?.toLongOrNull()
                    if (min != null && max != null) cpufreq += Cpufreq(f[1], min, max, f.drop(4).mapNotNull { it.toIntOrNull() })
                }
                "devfreq" -> {
                    val min = f.getOrNull(2)?.toLongOrNull()
                    val max = f.getOrNull(3)?.toLongOrNull()
                    if (min != null && max != null) devfreq += Devfreq(f[1], min, max)
                }
                "can" -> f.getOrNull(2)?.takeIf { it.startsWith("/") }?.let { can += it }
                "irq" -> {
                    val n = f.getOrNull(1)?.toIntOrNull()
                    if (n != null && f.size >= 3) irqs += Irq(n, f[2], f.drop(3).joinToString(" "))
                }
                "task" -> {
                    val pid = f.getOrNull(1)?.toIntOrNull()
                    val prio = f.getOrNull(2)?.toIntOrNull()
                    val policy = f.getOrNull(3)?.toIntOrNull()
                    if (pid != null && prio != null && policy != null && f.size >= 5) tasks += Task(pid, prio, policy, f.drop(4).joinToString(" "))
                }
            }
        }
        return Probe(boot, cpufreq, devfreq, can, irqs, tasks)
    }

    /** The READY lamp in a 0x234 payload (hex), or null if it's too short to say. */
    fun readyLamp(data: String): Boolean? {
        val b = data.takeIf { it.length >= 4 }?.substring(2, 4)?.toIntOrNull(16) ?: return null
        return ((b shr 4) and 1) == 1
    }

    fun gpus(p: Probe): List<Devfreq> = p.devfreq.filter { GPU.containsMatchIn(it.name) }

    /**
     * The interrupts to move: the CAN chips' (named mcp251x, or after their SPI device, e.g. spi1.0) and
     * their SPI controller's (named after its platform device, e.g. a84000.spi, from the CAN devices' sysfs paths).
     */
    fun canIrqs(p: Probe): List<Irq> {
        val names = HashSet<String>()
        for (path in p.can) {
            val parts = path.split('/')
            parts.lastOrNull()?.takeIf { SPI_DEVICE.matches(it) }?.let { names += it }
            parts.indexOf("spi_master").takeIf { it > 0 }?.let { names += parts[it - 1] }
        }
        return p.irqs.filter { irq -> irq.desc.contains("mcp251", ignoreCase = true) || names.any { irq.desc.contains(it) } }
    }

    /** The threads to raise: the [canIrqs]' interrupt threads, and the CAN devices' SPI controllers' message threads (spi1). */
    fun canTasks(p: Probe): List<Task> {
        val irqs = canIrqs(p).map { it.n }.toSet()
        val controllers = p.can.mapNotNull { path -> path.split('/').lastOrNull { SPI_CONTROLLER.matches(it) } }.toSet()
        return p.tasks.filter { t ->
            val irq = IRQ_THREAD.matchEntire(t.comm)?.groupValues?.get(1)?.toIntOrNull()
            (irq != null && irq in irqs) || t.comm in controllers
        }
    }

    /** The last core of CPU 0's cluster, else CPU 1, else null (one core: nowhere to go). */
    fun irqCpu(p: Probe): Int? {
        val cluster = p.cpufreq.firstOrNull { 0 in it.cpus }?.cpus?.maxOrNull()
        if (cluster != null && cluster > 0) return cluster
        return if (p.cpufreq.any { 1 in it.cpus }) 1 else null
    }

    private fun high(t: Task) = (t.policy == SCHED_FIFO || t.policy == SCHED_RR) && t.rtPriority >= RT_PRIORITY

    /** The chrt that puts [t] back as it was, or null for a policy this doesn't know (deadline): then it's left alone. */
    private fun chrtBack(t: Task): String? = when (t.policy) {
        SCHED_OTHER -> "$CHRT -o -p ${t.pid} 0"
        SCHED_FIFO -> "$CHRT -f -p ${t.pid} ${t.rtPriority}"
        SCHED_RR -> "$CHRT -r -p ${t.pid} ${t.rtPriority}"
        SCHED_BATCH -> "$CHRT -b -p ${t.pid} 0"
        SCHED_IDLE -> "$CHRT -i -p ${t.pid} 0"
        else -> null
    }

    fun plan(p: Probe): Plan {
        val boost = ArrayList<String>()
        val restore = ArrayList<String>()
        for (c in p.cpufreq) if (c.min < c.max) {
            boost += "echo ${c.max} > ${c.path}/scaling_min_freq"
            restore += "echo ${c.min} > ${c.path}/scaling_min_freq"
        }
        for (d in gpus(p)) if (d.min < d.max) {
            boost += "echo ${d.max} > ${d.path}/min_freq"
            restore += "echo ${d.min} > ${d.path}/min_freq"
        }
        val cpu = irqCpu(p)
        if (cpu != null) for (irq in canIrqs(p)) if (irq.affinity != "-" && irq.affinity != cpu.toString()) {
            boost += "echo $cpu > /proc/irq/${irq.n}/smp_affinity_list"
            restore += "echo ${irq.affinity} > /proc/irq/${irq.n}/smp_affinity_list"
        }
        for (t in canTasks(p)) {
            if (high(t)) continue
            val back = chrtBack(t) ?: continue
            boost += "$CHRT -f -p ${t.pid} $RT_PRIORITY"
            restore += back
        }
        return Plan(boost, restore.reversed())
    }

    /** How far [p] (a probe after boosting) shows the head unit flat out. */
    fun result(p: Probe): Result {
        val target = irqCpu(p)
        val ourIrqs = canIrqs(p)
        val ourTasks = canTasks(p)
        val ourGpus = gpus(p)
        return Result(
            cpu = Count(p.cpufreq.count { it.min >= it.max }, p.cpufreq.size),
            gpu = Count(ourGpus.count { it.min >= it.max }, ourGpus.size),
            irqs = Count(if (target == null) 0 else ourIrqs.count { it.affinity == target.toString() }, ourIrqs.size),
            irqCpu = target,
            threads = Count(ourTasks.count { high(it) }, ourTasks.size),
        )
    }
}
