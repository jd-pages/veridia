using System;
using System.Reflection;

// Test-only shell. Load the actual pinned shipped host; never compile it in a
// timed Unit or duplicate the production termination/remaining-budget policy.
internal static class TerminationContract {
 static MethodInfo Method;
 static bool Confirm(int error,Func<int> remaining,Func<uint,uint> wait){
  return (bool)Method.Invoke(null,new object[]{error,remaining,wait});
 }
 public static int Main(string[] args){
  Method=Assembly.LoadFile(args[0]).GetType("VeridiaProfileProbeHost",true)
   .GetMethod("ConfirmTerminationExit",BindingFlags.Static|BindingFlags.NonPublic);
  if(Method==null)return 8;
  int calls=0;Func<uint,uint> exited=remaining=>{if(remaining!=1980)throw new Exception("BUDGET_CHANGED");calls++;return 0;};
  if(!Confirm(5,()=>1980,exited)||calls!=1)return 1;
  if(Confirm(5,()=>1980,remaining=>258))return 2;
  if(Confirm(5,()=>1980,remaining=>UInt32.MaxValue))return 3;
  if(Confirm(6,()=>{throw new Exception("OTHER_ERROR_WAITED");},exited))return 4;
  if(Confirm(5,()=>0,exited)||calls!=1)return 5;
  if(Confirm(5,()=>-1,exited)||calls!=1)return 6;
  try{Confirm(5,()=>1980,remaining=>{throw new Exception("WAIT_FAILED");});return 7;}
  catch(TargetInvocationException e){if(e.InnerException.Message!="WAIT_FAILED")throw;}
  Console.WriteLine("EXIT_CONFIRMED_LIVE_UNKNOWN_OTHER_ERROR_DEADLINE_REJECTED_NO_RETRY");return 0;
 }
}
