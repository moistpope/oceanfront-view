package ai.sunnypilot.webhud

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PerfPlanTest {
    // assets/perf/probe.sh's output on a made-up Snapdragon-like head unit: three clusters (the last already
    // pinned), the GPU and its bus, UFS, both CAN chips on spi1 (a84000.spi) and an unrelated SPI controller
    private val probe = """
        boot 3f2a9c1e-7b44-4c0e-9d1a-2b6f0e8c5a11
        cpufreq /sys/devices/system/cpu/cpufreq/policy0 300000 1785600 0 1 2 3
        cpufreq /sys/devices/system/cpu/cpufreq/policy4 710400 2131200 4 5 6
        cpufreq /sys/devices/system/cpu/cpufreq/policy7 2419200 2419200 7
        devfreq /sys/class/devfreq/1d84000.ufshc 37500000 300000000
        devfreq /sys/class/devfreq/3d00000.qcom,kgsl-3d0 257000000 587000000
        devfreq /sys/class/devfreq/soc:qcom,gpubw 0 7980
        can can1 /sys/devices/platform/soc/a84000.spi/spi_master/spi1/spi1.0
        can can2 /sys/devices/platform/soc/a84000.spi/spi_master/spi1/spi1.1
        irq 287 0-7 9876543          0          0          0          0          0          0          0   msmgpio  87 Edge      mcp251x
        irq 288 0-7 8765432          0          0          0          0          0          0          0   msmgpio  88 Edge      mcp251x
        irq 301 0-7 555555          0          0          0          0          0          0          0     GIC-0 633 Level     a84000.spi
        irq 302 0-7 100          0          0          0          0          0          0          0     GIC-0 634 Level     a90000.spi
        task 123 50 1 irq/287-mcp251x
        task 124 50 1 irq/288-mcp251x
        task 130 0 0 spi1
        task 131 0 0 spi3
        task 140 50 1 irq/302-a90000.
        task 141 50 1 irq/301-a84000.
        task 150 50 1 irq/3-arch_time
        some error line from the shell
    """.trimIndent()

    @Test
    fun readsTheProbe() {
        val p = PerfPlan.parse(probe)
        assertEquals("3f2a9c1e-7b44-4c0e-9d1a-2b6f0e8c5a11", p.bootId)
        assertEquals(listOf(0, 1, 2, 3), p.cpufreq[0].cpus)
        assertEquals(3, p.devfreq.size)
        assertEquals(2, p.can.size)
        assertEquals(PerfPlan.Irq(287, "0-7", p.irqs[0].desc), p.irqs[0])
        assertTrue(p.irqs[0].desc.endsWith("mcp251x"))
        assertEquals(PerfPlan.Task(130, 0, 0, "spi1"), p.tasks.first { it.pid == 130 })
    }

    @Test
    fun picksTheCanChipsAndTheirSpiControllerOnly() {
        val p = PerfPlan.parse(probe)
        assertEquals(listOf(287, 288, 301), PerfPlan.canIrqs(p).map { it.n })
        assertEquals(setOf(123, 124, 130, 141), PerfPlan.canTasks(p).map { it.pid }.toSet())
        assertEquals(listOf("3d00000.qcom,kgsl-3d0", "soc:qcom,gpubw"), PerfPlan.gpus(p).map { it.name })
        assertEquals(3, PerfPlan.irqCpu(p))   // the last core of CPU 0's cluster
    }

    @Test
    fun boostsAndPutsEveryValueBack() {
        val plan = PerfPlan.plan(PerfPlan.parse(probe))
        val boost = plan.boost.toSet()
        val restore = plan.restore.toSet()
        assertTrue("echo 1785600 > /sys/devices/system/cpu/cpufreq/policy0/scaling_min_freq" in boost)
        assertTrue("echo 300000 > /sys/devices/system/cpu/cpufreq/policy0/scaling_min_freq" in restore)
        assertFalse(plan.boost.any { "policy7" in it })   // already at its top
        assertTrue("echo 587000000 > /sys/class/devfreq/3d00000.qcom,kgsl-3d0/min_freq" in boost)
        assertFalse(plan.boost.any { "ufshc" in it })
        assertTrue("echo 3 > /proc/irq/301/smp_affinity_list" in boost)
        assertTrue("echo 0-7 > /proc/irq/301/smp_affinity_list" in restore)
        assertFalse(plan.boost.any { "/proc/irq/302/" in it })
        assertTrue("/system/bin/toybox chrt -f -p 123 80" in boost)
        // put back only while the pid is still that thread (a driver reload ends the interrupt threads)
        assertTrue("[ \"\$(cat /proc/123/comm 2>/dev/null)\" = 'irq/287-mcp251x' ] && /system/bin/toybox chrt -f -p 123 50" in restore)
        assertTrue("[ \"\$(cat /proc/130/comm 2>/dev/null)\" = 'spi1' ] && /system/bin/toybox chrt -o -p 130 0" in restore)
        assertFalse(plan.boost.any { " 140 " in it || " 131 " in it })
        // 2 clusters + 2 GPU clocks + 3 interrupts + 4 threads, each with its way back
        assertEquals(11, plan.boost.size)
        assertEquals(plan.boost.size, plan.restore.size)
    }

    @Test
    fun countsWhatTook() {
        // after boosting: one interrupt (a GPIO one) refused to move, and spi1 kept its priority
        val after = probe
            .replace("policy0 300000", "policy0 1785600").replace("policy4 710400", "policy4 2131200")
            .replace("kgsl-3d0 257000000", "kgsl-3d0 587000000").replace("gpubw 0 7980", "gpubw 7980 7980")
            .replace("irq 287 0-7", "irq 287 3").replace("irq 301 0-7", "irq 301 3")
            .replace("task 123 50 1", "task 123 80 1").replace("task 124 50 1", "task 124 80 1").replace("task 141 50 1", "task 141 80 1")
        val r = PerfPlan.result(PerfPlan.parse(after))
        assertEquals(PerfPlan.Count(3, 3), r.cpu)
        assertEquals(PerfPlan.Count(2, 2), r.gpu)
        assertEquals(PerfPlan.Count(2, 3), r.irqs)
        assertEquals(3, r.irqCpu)
        assertEquals(PerfPlan.Count(3, 4), r.threads)
        // nothing left to do for what took
        val again = PerfPlan.plan(PerfPlan.parse(after))
        assertFalse(again.boost.any { "cpufreq" in it || "devfreq" in it || " 123 " in it })
    }

    @Test
    fun withoutTheCanDevicesPathsTheChipsAreStillFoundByName() {
        val p = PerfPlan.parse(probe.lines().filterNot { it.startsWith("can ") }.joinToString("\n"))
        assertEquals(listOf(287, 288), PerfPlan.canIrqs(p).map { it.n })
        assertEquals(setOf(123, 124), PerfPlan.canTasks(p).map { it.pid }.toSet())
    }

    @Test
    fun oneCoreHasNowhereToMoveTheInterruptsTo() {
        val p = PerfPlan.parse("cpufreq /sys/devices/system/cpu/cpufreq/policy0 300000 1000000 0\nirq 287 0 1 x mcp251x")
        assertNull(PerfPlan.irqCpu(p))
        assertFalse(PerfPlan.plan(p).boost.any { "smp_affinity" in it })
    }

    @Test
    fun readsTheReadyLamp() {
        // VCU_0x234 as the page's DBC encodes it: the lamp is byte 1 bit 4, beside the alive counter
        assertEquals(true, PerfPlan.readyLamp("0010000000000000"))
        assertEquals(false, PerfPlan.readyLamp("000f000000000000"))
        assertEquals(true, PerfPlan.readyLamp("ff1f000000000000"))
        assertNull(PerfPlan.readyLamp("00"))
    }
}
