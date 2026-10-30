# What full speed in Ready may change, read-only, one tagged line each (PerfPlan.parse reads them):
#   boot <boot id>
#   cpufreq <policy dir> <scaling_min_freq> <scaling_max_freq> <related cpus...>
#   devfreq <device dir> <min_freq> <max_freq>
#   can <iface> <its device's sysfs path>
#   irq <n> <smp_affinity_list> <the rest of its /proc/interrupts line>
#   task <pid> <rt_priority> <policy> <comm>          (interrupt threads and SPI message threads)
# A value that can't be read is "-". It runs in the app's root shell, which reads its commands from
# stdin: nothing here may read stdin.
v() { cat "$1" 2>/dev/null || echo -; }
echo "boot $(v /proc/sys/kernel/random/boot_id)"
for p in /sys/devices/system/cpu/cpufreq/policy*; do
  [ -d "$p" ] && echo "cpufreq $p $(v $p/scaling_min_freq) $(v $p/scaling_max_freq) $(v $p/related_cpus)"
done
for d in /sys/class/devfreq/*; do
  [ -e "$d/min_freq" ] && echo "devfreq $d $(v $d/min_freq) $(v $d/max_freq)"
done
for n in can1 can2; do
  echo "can $n $(readlink -f /sys/class/net/$n/device 2>/dev/null)"
done
grep -iE 'mcp251|spi' /proc/interrupts 2>/dev/null | while read -r n rest; do
  n=${n%:}
  echo "irq $n $(v /proc/irq/$n/smp_affinity_list) $rest"
done
for c in $(grep -lE '^(irq/[0-9]+-.*|spi[0-9]+)$' /proc/[0-9]*/comm 2>/dev/null); do
  d=${c%/comm}
  # /proc/<pid>/stat after the comm: field 3 (state) first, so rt_priority (40) and policy (41) are 38 and 39
  set -- $(sed 's/.*) //' $d/stat 2>/dev/null)
  [ $# -ge 39 ] && shift 37 && echo "task ${d#/proc/} $1 $2 $(v $c)"
done
true
