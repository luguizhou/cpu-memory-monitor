const fs = require('fs')
const path = require('path')

const bytes = require('bytes')

//获取当前进程pid根据pid 反馈memory和cup使用情况
const pusage = require('pidusage')

//内存快照 制定输出文件即可 使c++写的包
const heapdump = require('heapdump')

//已不可用 todo c++写的
const profiler = require('v8-profiler')

//已不可用 todo c++写的包
const memwatch = require('memwatch-next')

//控制速率的 在制定时间内，触发次数
const RateLimiter = require('limiter').RateLimiter

const processing = {
  cpu: false,
  memory: false
}

//统计出发快照次数
const counter = {
  cpu: 0,
  memory: 0
}

function genProfilePath (profileDir, prefix, suffix) {
  return path.join(profileDir, `${prefix}-${process.pid}-${Date.now()}.${suffix}`)
}

function dumpCpu (cpuProfileDir, cpuDuration) {
  profiler.startProfiling()
  processing.cpu = true
  setTimeout(() => {
    const profile = profiler.stopProfiling()
    const filepath = genProfilePath(cpuProfileDir, 'cpu', 'cpuprofile')
    profile.export()
      .pipe(fs.createWriteStream(filepath))
      .on('finish', () => {
        processing.cpu = false
        profile.delete()
        console.error(`cpuprofile export success: ${filepath}`)
      })
      .on('error', (error) => {
        processing.cpu = false
        console.error(`cpuprofile export error: ${error.message}`)
        console.error(error.stack)
      })
  }, cpuDuration)
}

//根据传过来的文件地址生产快照
function dumpMemory (memProfileDir, isLeak = false) {
  processing.memory = true
  const filepath = genProfilePath(memProfileDir, isLeak ? 'leak-memory' : 'memory', 'heapsnapshot')
  heapdump.writeSnapshot(filepath, (error, filename) => {
    processing.memory = false
    if (error) {
      console.error(`heapsnapshot dump error: ${error.message}`)
      console.error(error.stack)
      return
    }
    console.log(`heapsnapshot dump success: ${filename}`)
  })
}

module.exports = function cpuMemoryMonitor (options = {}) {
  const cpuOptions = options.cpu || {}
  const cpuInterval = cpuOptions.interval || 1000
  const cpuDuration = cpuOptions.duration || 30000
  const cpuThreshold = cpuOptions.threshold || 90
  const cpuProfileDir = cpuOptions.profileDir || process.cwd()
  const cpuCounter = cpuOptions.counter || 1
  const cpuLimiterOpt = cpuOptions.limiter || []
  const cpuLimiter = new RateLimiter(cpuLimiterOpt[0] || 3, cpuLimiterOpt[1] || 'hour', true)

  const memOptions = options.memory || {}
  const memInterval = memOptions.interval || 1000
  const memThreshold = bytes.parse(memOptions.threshold || '1.2gb')
  const memProfileDir = memOptions.profileDir || process.cwd()
  const memCounter = memOptions.counter || 1
  const memLimiterOpt = memOptions.limiter || []
  const memLimiter = new RateLimiter(memLimiterOpt[0] || 3, memLimiterOpt[1] || 'hour', true)

  if (options.cpu) {
    const cpuTimer = setInterval(() => {
      if (processing.cpu) {
        return
      }
      pusage.stat(process.pid, (err, stat) => {
        if (err) {
          console.error(`cpu stat error: ${err.message}`)
          console.error(err.stack)
          clearInterval(cpuTimer)
          return
        }
        if (stat.cpu > cpuThreshold) {
          counter.cpu += 1
          if (counter.cpu >= cpuCounter) {
            memLimiter.removeTokens(1, (limiterErr, remaining) => {
              if (limiterErr) {
                console.error(`limiterErr: ${limiterErr.message}`)
                console.error(limiterErr.stack)
                return
              }
              if (remaining > -1) {
                dumpCpu(cpuProfileDir, cpuDuration)
                counter.cpu = 0
              }
            })
          }
        } else {
          counter.cpu = 0
        }
      })
    }, cpuInterval)
  }

  if (options.memory) {
    
    //根据memInterval 定时执行判断是否要生成快照
    const memTimer = setInterval(() => {
      if (processing.memory) {
        return
      }
      
      //根据process.pid 获取当前进程的cpu和memory情况
      pusage.stat(process.pid, (err, stat) => {
        if (err) {
          console.error(`memory stat error: ${err.message}`)
          console.error(err.stack)
          clearInterval(memTimer)
          return
        }
        
        //达到阈值触发
        if (stat.memory > memThreshold) {
          counter.memory += 1
          if (counter.memory >= memCounter) {
            
            //根据速率控制器 出发dump动作
            cpuLimiter.removeTokens(1, (limiterErr, remaining) => {
              if (limiterErr) {
                console.error(`limiterErr: ${limiterErr.message}`)
                console.error(limiterErr.stack)
                return
              }
              
              //当达到频次阈值后，触发。为了控制粗发频次，触发阈值memLimiter次后 ，dump
              if (remaining > -1) {
                dumpMemory(memProfileDir)
                counter.memory = 0
              }
            })
          }
        } else {
          counter.memory = 0
        }
      })
    }, memInterval)

    //包兼容问题已不可用，c++写的包
    memwatch.on('leak', (info) => {
      console.warn('memory leak: %j', info)
      dumpMemory(memProfileDir, true)
    })
  }
}
